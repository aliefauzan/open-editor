// D-81 measurement: the committed clipper/stylize replay fixtures run again with an Anthropic editor.
// Each step's state block is kept in the history and later steps send only the changes, so the
// uncached state text per run drops; the replays must still give the recorded tool results.
// Before = the full block every step (what the run record's `fullChars` gives; the pre-D-81 text),
// after = the block each step sent. VOX_STATE_REPORT=1 prints the numbers.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readRunRecord, type RecordLine } from '../../src/loop/record.ts';
import { runAgent } from '../../src/loop/run.ts';
import { DIFF_STATE_HEADER, FULL_STATE_HEADER } from '../../src/loop/state.ts';
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

describe('state diff on the replay fixtures (D-81 measurement)', () => {
  test.each(FIXTURES)(
    '%s: same tool results; less uncached state text than the full block every step',
    async (name) => {
      const f = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Fixture;
      const kit = await workflowKit({ limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } });
      const sequenceIds = f.setup === 'quick1' ? (await quickClipsProject(kit, 1)).sequenceIds : [];
      const m = scriptedModel(scriptFromRecord(f.lines));
      kit.deps.models = {
        editor: role(m.model, {
          price: { inPerMTok: 3, outPerMTok: 15 },
          provider: { type: 'anthropic', label: 'Anthropic' },
          modelId: 'claude-sonnet-4-5',
        }),
      };
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
      const before = states.reduce((n, l) => n + Math.ceil(Number(l['fullChars']) / 3), 0);
      const after = states.reduce((n, l) => n + Math.ceil(Number(l['chars']) / 3), 0);
      const per = tools.map((o) => stateTokens(o.prompt as never));
      const kept = per.reduce((n, p) => n + p.kept, 0);
      if (REPORT)
        console.info(
          JSON.stringify({
            fixture: name,
            steps: states.length,
            fullBlocks: states.filter((l) => l['kind'] === 'full').length,
            beforeStateTokens: before,
            afterUncachedStateTokens: after,
            afterCachedStateTokens: kept,
          }),
        );
      expect(after).toBeLessThanOrEqual(before);
      if (states.length > 2) expect(after).toBeLessThan(before);
    },
    120_000,
  );
});

/**
 * A longer edit run on a bigger state, as in a stylize pass: 24 scenes on V2, then 20 steps that
 * each move one scene. The same script runs on the pre-D-81 code for the before numbers (D-81 log).
 */
export async function longEditRun(sim: AnthropicCacheSim) {
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
    { limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } },
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
  test('20 moves on a 24-scene sequence: far less uncached state text, lower input cost', async () => {
    const sim = new AnthropicCacheSim();
    const r = await longEditRun(sim);
    const states = readRunRecord(r.run.record.path).filter((l) => l.type === 'state');
    expect(states).toHaveLength(21);
    const before = states.reduce((n, l) => n + Math.ceil(Number(l['fullChars']) / 3), 0);
    const after = states.reduce((n, l) => n + Math.ceil(Number(l['chars']) / 3), 0);
    const t = sim.totals();
    const inputUsd = (t.noCache * 3 + t.cacheRead * 0.3 + t.cacheWrite * 3.75) / 1e6;
    if (REPORT)
      console.info(
        JSON.stringify({
          fixture: 'long-edit',
          steps: states.length,
          fullBlocks: states.filter((l) => l['kind'] === 'full').length,
          beforeStateTokens: before,
          afterUncachedStateTokens: after,
          sim: { ...t, inputUsd },
        }),
      );
    expect(after).toBeLessThan(before * 0.4);
  }, 120_000);
});
