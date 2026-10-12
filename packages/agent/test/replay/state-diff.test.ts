// D-81 measurement: the committed clipper/stylize replay fixtures and a longer edit run, with an
// Anthropic editor and the D-76 cache fake, in three modes: `pre` = the full block every step, not
// kept (the pre-D-81 state: stateDiffMinTokens Infinity), `diff` = always kept and diffed (D-81 as
// first merged: 0), `threshold` = the default STATE_DIFF_MIN_TOKENS. The replays must still give
// the recorded tool results; the threshold must cost no more than `pre` on the short fixtures and
// keep most of the diff's saving on the long run. VOX_STATE_REPORT=1 prints the numbers.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readRunRecord, type RecordLine } from '../../src/loop/record.ts';
import { runAgent } from '../../src/loop/run.ts';
import {
  DIFF_STATE_HEADER,
  FULL_STATE_HEADER,
  STATE_DIFF_MIN_TOKENS,
} from '../../src/loop/state.ts';
import { estimateTokens } from '../../src/providers/tool-cost.ts';
import { runWorkflow, type WorkflowRequest } from '../../src/workflows/run-workflow.ts';
import { AnthropicCacheSim } from '../helpers/anthropic-cache.ts';
import { roleModel, runDeps, scriptedModel, type ScriptStep } from '../helpers/model.ts';
import { fixtureProject } from '../helpers/project.ts';
import { quickClipsProject, REPO, role, workflowKit } from '../helpers/workflow.ts';
import { normaliseIds, scriptFromRecord, toolTrace } from './harness.ts';

const DIR = new URL('./fixtures/', import.meta.url).pathname;
const REPORT = process.env['VOX_STATE_REPORT'] === '1';

interface Fixture {
  name: string;
  setup: 'empty' | 'quick1';
  request: Omit<WorkflowRequest, 'projectId' | 'sequenceIds'> & { stylizeQuick?: boolean };
  lines: RecordLine[];
}

const TMP = tmpdir();
const toFixture = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v)
      .split(REPO)
      .join('<REPO>')
      .split(TMP)
      .join('<TMP>')
      .replace(/<TMP>\/[A-Za-z0-9._-]+/g, '<TMP>/x'),
  );
const comparable = (lines: RecordLine[]) =>
  normaliseIds(
    JSON.parse(
      JSON.stringify(toolTrace(toFixture(lines) as RecordLine[])).replace(
        /\b(seq|it|m|p)_[A-Za-z0-9_-]+/g,
        (id, k: string) => `${k}_X${String(id.length)}`,
      ),
    ),
  ).map((t) => JSON.stringify(t));

/** Per request: the state block it sent (uncached) and the earlier blocks it re-sent (cached). */
function stateTokens(prompt: { role: string; content: unknown }[]) {
  const blocks = prompt
    .filter((m) => m.role === 'user')
    .flatMap((m) => (m.content as { type: string; text?: string }[]).map((p) => p.text ?? ''))
    .filter((t) => t.startsWith(FULL_STATE_HEADER) || t.startsWith(DIFF_STATE_HEADER));
  const last = blocks.at(-1) ?? '';
  return {
    sent: estimateTokens(last),
    kept: blocks.slice(0, -1).reduce((n, t) => n + estimateTokens(t), 0),
  };
}

const FIXTURES = ['clipper-tools', 'clipper-subruns', 'stylize-tools'];

const PRICE = { inPerMTok: 3, outPerMTok: 15 };
const inputUsd = (t: ReturnType<AnthropicCacheSim['totals']>) =>
  (t.noCache * PRICE.inPerMTok + t.cacheRead * 0.3 + t.cacheWrite * 3.75) / 1e6;
const MODES = { pre: Number.POSITIVE_INFINITY, diff: 0, threshold: undefined } as const;

async function replay(f: Fixture, stateDiffMinTokens: number | undefined) {
  const kit = await workflowKit({ limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } });
  const sequenceIds = f.setup === 'quick1' ? (await quickClipsProject(kit, 1)).sequenceIds : [];
  const sim = new AnthropicCacheSim();
  const m = scriptedModel(scriptFromRecord(f.lines), { usage: (o) => sim.modelUsage(o) });
  kit.deps.models = {
    editor: role(m.model, {
      price: PRICE,
      provider: { type: 'anthropic', label: 'Anthropic' },
      modelId: 'claude-sonnet-4-5',
    }),
  };
  if (stateDiffMinTokens !== undefined) kit.deps.stateDiffMinTokens = stateDiffMinTokens;
  const { stylizeQuick, ...req } = JSON.parse(
    JSON.stringify(f.request).split('<REPO>').join(REPO),
  ) as Fixture['request'];
  const r = await runWorkflow(kit.deps, {
    ...req,
    projectId: kit.projectId,
    ...(stylizeQuick && { sequenceIds }),
  });
  expect(r.done.status, r.done.summary).toBe('completed');
  expect(m.remaining()).toBe(0);
  const lines = readRunRecord(r.run.record.path);
  expect(comparable(lines)).toEqual(comparable(f.lines));
  const states = lines.filter((l) => l.type === 'state');
  const tools = m.prompts.filter((o) => o.tools && o.tools.length > 0);
  expect(states.length).toBe(tools.length);
  return {
    states,
    per: tools.map((o) => stateTokens(o.prompt as never)),
    usd: inputUsd(sim.totals()),
    uncached: states.reduce((n, l) => n + Math.ceil(Number(l['chars']) / 3), 0),
    full: states.reduce((n, l) => n + Math.ceil(Number(l['fullChars']) / 3), 0),
  };
}

describe('state diff on the replay fixtures (D-81 measurement)', () => {
  test.each(FIXTURES)(
    '%s: same tool results; below the threshold the full block every step, cost ≤ pre-D-81',
    async (name) => {
      const f = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Fixture;
      const pre = await replay(f, MODES.pre);
      const diff = await replay(f, MODES.diff);
      const thr = await replay(f, MODES.threshold);
      if (REPORT)
        console.info(
          JSON.stringify({
            fixture: name,
            steps: thr.states.length,
            preUsd: pre.usd,
            diffUsd: diff.usd,
            thresholdUsd: thr.usd,
            fullStateTokens: pre.full,
            diffUncachedStateTokens: diff.uncached,
            diffCachedStateTokens: diff.per.reduce((n, p) => n + p.kept, 0),
          }),
        );
      // these states are small: every block is sent in full, newest only, as before D-81
      expect(thr.states.every((l) => l['kind'] === 'unkept')).toBe(true);
      expect(thr.per.every((p) => p.kept === 0)).toBe(true);
      expect(thr.usd).toBeLessThanOrEqual(pre.usd);
      // always diffing sends less uncached state text but costs more here (the kept blocks' writes)
      expect(diff.uncached).toBeLessThan(diff.full);
      expect(diff.usd).toBeGreaterThan(pre.usd);
    },
    240_000,
  );
});

/**
 * A longer edit run on a bigger state, as in a stylize pass: 24 scenes on V2, then 20 steps that
 * each move one scene. The same script runs on the pre-D-81 code for the before numbers (D-81 log).
 */
export async function longEditRun(sim: AnthropicCacheSim, stateDiffMinTokens?: number) {
  const f = await fixtureProject();
  const scenes: string[] = [];
  for (let i = 0; i < 24; i++) {
    await f.engine.applyOp(
      f.projectId,
      {
        op: 'addScene',
        args: {
          sequenceId: f.sequenceId,
          trackId: 'V2',
          template: 'base/title',
          startMs: i * 800,
          durationMs: 500,
          variables: { title: `Scene number ${String(i)} of the long edit` },
        },
      } as never,
      { actor: 'user' },
    );
  }
  const p = await f.engine.getProject(f.projectId);
  for (const t of p.sequences[0]!.videoTracks)
    for (const it of t.items) if (it.type === 'scene') scenes.push(it.id);
  const script: ScriptStep[] = [
    ...scenes.slice(0, 20).map((id, i) => ({
      calls: [
        {
          name: 'move_item',
          input: { sequenceId: f.sequenceId, itemId: id, startMs: i * 800 + 100 },
        },
      ],
    })),
    { text: 'done' },
  ];
  const m = scriptedModel(script, { usage: (o) => sim.modelUsage(o) });
  const { deps } = runDeps(
    f,
    roleModel(m.model, {
      provider: { type: 'anthropic', label: 'Anthropic' },
      modelId: 'claude-sonnet-4-5',
      price: { inPerMTok: 3, outPerMTok: 15 },
    }),
    {
      limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 },
      ...(stateDiffMinTokens !== undefined && { stateDiffMinTokens }),
    },
  );
  const r = await runAgent(deps, {
    projectId: f.projectId,
    workflow: 'freeform',
    message: 'move the scenes a little later',
    allowedTools: ['move_item'],
    mode: 'tools',
    scope: [f.sequenceId],
  });
  expect(r.done.status).toBe('completed');
  return r;
}

describe('state diff on a long edit run (D-81 measurement)', () => {
  test('20 moves on a 24-scene sequence: above the threshold, far less uncached state, lower cost', async () => {
    const run = async (min: number | undefined) => {
      const sim = new AnthropicCacheSim();
      const r = await longEditRun(sim, min);
      const states = readRunRecord(r.run.record.path).filter((l) => l.type === 'state');
      expect(states).toHaveLength(21);
      return {
        states,
        usd: inputUsd(sim.totals()),
        full: states.reduce((n, l) => n + Math.ceil(Number(l['fullChars']) / 3), 0),
        uncached: states.reduce((n, l) => n + Math.ceil(Number(l['chars']) / 3), 0),
      };
    };
    const pre = await run(MODES.pre);
    const diff = await run(MODES.diff);
    const thr = await run(MODES.threshold);
    if (REPORT)
      console.info(
        JSON.stringify({
          fixture: 'long-edit',
          steps: thr.states.length,
          fullBlocks: thr.states.filter((l) => l['kind'] === 'full').length,
          preUsd: pre.usd,
          diffUsd: diff.usd,
          thresholdUsd: thr.usd,
          fullStateTokens: thr.full,
          thresholdUncachedStateTokens: thr.uncached,
        }),
      );
    // the block is over the threshold: the threshold run is the diff run
    expect(Math.ceil(Number(thr.states[0]!['fullChars']) / 3)).toBeGreaterThan(
      STATE_DIFF_MIN_TOKENS,
    );
    expect(thr.usd).toBe(diff.usd);
    expect(thr.uncached).toBeLessThan(thr.full * 0.4);
    expect(thr.usd).toBeLessThan(pre.usd * 0.85);
  }, 240_000);
});
