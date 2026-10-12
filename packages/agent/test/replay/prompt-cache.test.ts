// D-76 measurement: the committed clipper/stylize replay fixtures run again with an Anthropic editor
// and a fake of Anthropic's prompt cache (test/helpers/anthropic-cache.ts). Before = the same run
// without breakpoints (all input fresh); after = with them. The replays must still give the
// recorded tool results, the run's cost must equal the fake's usage at Anthropic's cache prices,
// and most input must be read from the cache. VOX_CACHE_REPORT=1 prints the numbers.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readRunRecord, type RecordLine } from '../../src/loop/record.ts';
import type { RoleModel } from '../../src/loop/types.ts';
import { runWorkflow, type WorkflowRequest } from '../../src/workflows/run-workflow.ts';
import { AnthropicCacheSim } from '../helpers/anthropic-cache.ts';
import { scriptedModel } from '../helpers/model.ts';
import { quickClipsProject, REPO, role, workflowKit } from '../helpers/workflow.ts';
import { normaliseIds, scriptFromRecord, toolTrace } from './harness.ts';

const DIR = new URL('./fixtures/', import.meta.url).pathname;
const REPORT = process.env['VOX_CACHE_REPORT'] === '1';
/** Sonnet-class list prices, USD per million tokens. */
const PRICE = { inPerMTok: 3, outPerMTok: 15 };

interface Fixture {
  name: string;
  setup: 'empty' | 'quick1';
  request: Omit<WorkflowRequest, 'projectId' | 'sequenceIds'> & { stylizeQuick?: boolean };
  lines: RecordLine[];
}

const TMP = tmpdir();
/** As in workflows.test.ts: repo path and temp folders → placeholders, run-fixed ids → shapes. */
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

async function measure(f: Fixture, editor: Partial<RoleModel>) {
  const kit = await workflowKit({ limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } });
  const sequenceIds = f.setup === 'quick1' ? (await quickClipsProject(kit, 1)).sequenceIds : [];
  const sim = new AnthropicCacheSim();
  const m = scriptedModel(scriptFromRecord(f.lines), { usage: (o) => sim.modelUsage(o) });
  kit.deps.models = { editor: role(m.model, { price: PRICE, ...editor }) };
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
  return {
    totals: sim.totals(),
    requests: sim.requests.length,
    costUsd: r.done.costUsd,
    lines: readRunRecord(r.run.record.path),
  };
}

const TOOL_FIXTURES = ['clipper-tools', 'clipper-subruns', 'stylize-tools'];

describe('prompt caching on the replay fixtures (D-76 measurement)', () => {
  test.each(TOOL_FIXTURES)(
    '%s: same tool results; most input read from the cache; cost at cache prices',
    async (name) => {
      const f = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Fixture;
      const before = await measure(f, {});
      const after = await measure(f, {
        provider: { type: 'anthropic', label: 'Anthropic' },
        modelId: 'claude-sonnet-4-5',
      });
      expect(comparable(after.lines)).toEqual(comparable(f.lines));
      expect(before.totals.cacheRead + before.totals.cacheWrite).toBe(0);
      // the run's cost is the fake's usage at 3 / 0.30 / 3.75 per MTok plus 20 output tokens a step
      const want =
        (after.totals.noCache * 3 +
          after.totals.cacheRead * 0.3 +
          after.totals.cacheWrite * 3.75 +
          after.requests * 20 * 15) /
        1e6;
      expect(after.costUsd).toBeCloseTo(want, 5); // done.costUsd has 6 decimals
      const inputUsd = (t: typeof after.totals) =>
        (t.noCache * 3 + t.cacheRead * 0.3 + t.cacheWrite * 3.75) / 1e6;
      if (REPORT)
        console.info(
          JSON.stringify({
            fixture: name,
            requests: after.requests,
            before: { ...before.totals, inputUsd: inputUsd(before.totals) },
            after: { ...after.totals, inputUsd: inputUsd(after.totals) },
          }),
        );
      expect(after.totals.cacheRead).toBeGreaterThan(after.totals.total * 0.5);
      expect(inputUsd(after.totals)).toBeLessThan(inputUsd(before.totals) * 0.6);
    },
    120_000,
  );
});
