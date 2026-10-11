// Phase 12 step 8b (D-15): sub-runs share the run id; the tighten list matches the fixture's pauses
// and applies as one undo entry per sequence (whole list, or a ticked subset that keeps keepMs);
// tighten-all never approves a source; --confirm-plan pauses before each plan and Stop applies
// nothing; the frontmatter allowedTools are exactly what is sent; no editor fails at start.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import type { PauseDecision, PauseInfo, TightenRange } from '../../src/loop/types.ts';
import { ALWAYS_PRESENT, buildRegistry } from '../../src/tools/registry.ts';
import { loadWorkflow } from '../../src/workflows/load.ts';
import { runWorkflow, type WorkflowRequest } from '../../src/workflows/run-workflow.ts';
import { sequenceEndMs } from '../../src/workflows/stylize.ts';
import { ENGINE_FIXTURES } from '../helpers/project.ts';
import { planStylist, toolsStylist } from '../helpers/stylists.ts';
import { dynamicModel, FIXTURE_VIDEO, role, workflowKit, type Kit } from '../helpers/workflow.ts';

const TRANSCRIPT = JSON.parse(
  readFileSync(join(ENGINE_FIXTURES, 'transcripts/talking-head-20s.json'), 'utf8'),
) as { words: { kind: string; startMs: number; endMs: number }[] };

async function clipper(kit: Kit, over: Partial<WorkflowRequest> = {}, next = toolsStylist()) {
  const m = dynamicModel(next);
  kit.deps.models = { editor: role(m.model) };
  const r = await runWorkflow(kit.deps, {
    projectId: kit.projectId,
    workflow: 'clipper',
    message: `make 2 vox clips from ${FIXTURE_VIDEO}`,
    mode: 'tools',
    count: 2,
    minMs: 4000,
    maxMs: 8000,
    tighten: 'all',
    ...over,
  });
  return { ...r, prompts: m.prompts };
}

/** The fixture's pauses ≥ 350 ms inside a source range, as sequence ms (keepMs 80). */
function expectedPauses(inMs: number, outMs: number) {
  return TRANSCRIPT.words
    .filter((w) => w.kind === 'pause' && w.endMs - w.startMs >= 350)
    .filter((w) => (w.startMs + w.endMs) / 2 >= inMs && (w.startMs + w.endMs) / 2 < outMs)
    .map((w) => [w.startMs - inMs + 40, w.endMs - inMs - 40]);
}

describe('clipper D-15 (step 8b)', () => {
  test('each sequence in its own sub-run with the same runId; allowedTools exactly sent', async () => {
    const kit = await workflowKit();
    const r = await clipper(kit);
    expect(r.done.status, r.done.summary).toBe('completed');
    const lines = readRunRecord(r.run.record.path);
    const subs = lines.filter((l) => l.type === 'subRun');
    expect(subs.map((l) => l['subRun'])).toEqual([1, 2]);
    expect(subs.map((l) => l['scope'])).toEqual(r.sequenceIds.map((id) => [id]));
    const steps = lines.filter((l) => l.type === 'step');
    expect(new Set(steps.map((l) => l['subRun']))).toEqual(new Set([1, 2]));
    const ids = new Set((await kit.engine.history(kit.projectId)).map((e) => e.runId));
    expect(ids).toEqual(new Set([r.done.runId]));
    const w = loadWorkflow('clipper');
    for (const p of r.prompts) {
      const sent = (p.tools ?? []).map((t) => (t as { name: string }).name);
      expect(sent).toEqual([...w.allowedTools, ...ALWAYS_PRESENT]);
    }
  }, 120_000);

  test('tighten-all: the list matches the fixture pauses; one removePauses entry per sequence', async () => {
    const kit = await workflowKit();
    const r = await clipper(kit);
    const lines = readRunRecord(r.run.record.path);
    const lists = lines.filter((l) => l.type === 'tighten');
    expect(lists).toHaveLength(2);
    const p = await kit.engine.getProject(kit.projectId);
    for (const l of lists) {
      const s = p.sequences.find((x) => x.id === l['sequenceId'])!;
      const want = expectedPauses(s.sourceRange!.inMs, s.sourceRange!.outMs);
      const got = (l['ranges'] as TightenRange[]).map((x) => [x.seqStartMs, x.seqEndMs]);
      expect(got).toHaveLength(want.length);
      got.forEach(([a, b], i) => {
        expect(Math.abs(a! - want[i]![0]!)).toBeLessThanOrEqual(34);
        expect(Math.abs(b! - want[i]![1]!)).toBeLessThanOrEqual(34);
      });
    }
    const h = await kit.engine.history(kit.projectId);
    for (const id of r.sequenceIds) {
      const cuts = h.filter(
        (e) => e.op === 'removePauses' && (e.args as { sequenceId?: string }).sequenceId === id,
      );
      expect(cuts).toHaveLength(1);
    }
  }, 120_000);

  test('ask: a ticked subset applies as remove_pauses { wordKeys } and keeps keepMs; [] skips', async () => {
    const kit = await workflowKit();
    const seen: PauseInfo[] = [];
    let ticked: PauseInfo | undefined;
    kit.deps.onPause = (p: PauseInfo): Promise<PauseDecision> => {
      seen.push(p);
      if (p.kind !== 'pauses') return Promise.resolve({ action: 'stop' });
      // tick the first range of the first list that has more than one; skip the others
      const tick = p.ranges!.length > 1 && ticked === undefined;
      if (tick) ticked = p;
      return Promise.resolve({
        action: 'continue',
        wordKeys: tick ? [p.ranges![0]!.wordKey] : [],
      });
    };
    // longer clips (6–12 s) hold more than one pause each
    const r = await clipper(kit, { tighten: 'ask', minMs: 6000, maxMs: 12000 });
    expect(r.done.status, r.done.summary).toBe('completed');
    const pauses = seen.filter((p) => p.kind === 'pauses');
    expect(pauses).toHaveLength(r.sequenceIds.length);
    expect(pauses[0]!.ranges![0]).toMatchObject({
      kind: 'pause',
      text: expect.stringMatching(/^\(pause \d+ ms\)$/),
    });
    const h = await kit.engine.history(kit.projectId);
    const cuts = h.filter((e) => e.op === 'removePauses');
    expect(cuts).toHaveLength(1);
    expect(ticked, 'a list with two or more pauses').toBeDefined();
    expect((cuts[0]!.args as { wordKeys?: string[] }).wordKeys).toEqual([
      ticked!.ranges![0]!.wordKey,
    ]);
    // the cut is the ticked range (keepMs kept at both sides): the clip got shorter by its length
    const r0 = ticked!.ranges![0]!;
    const p = await kit.engine.getProject(kit.projectId);
    const s = p.sequences.find(
      (x) => x.id === (cuts[0]!.args as { sequenceId: string }).sequenceId,
    )!;
    const range = s.sourceRange!.outMs - s.sourceRange!.inMs;
    expect(Math.abs(range - (r0.seqEndMs - r0.seqStartMs) - sequenceEndMs(s))).toBeLessThanOrEqual(
      34,
    );
    const statuses = r.checkpoints.filter((c) => c.checkpoint === 'tighten').map((c) => c.status);
    expect(statuses.filter((x) => x === 'met')).toHaveLength(1);
    expect(statuses.filter((x) => x === 'skipped')).toHaveLength(pauses.length - 1);
  }, 120_000);

  test('tighten-all never approves a source: an unnamed ingest still pauses', async () => {
    const kit = await workflowKit();
    const onPause = vi.fn((_p: PauseInfo) => Promise.resolve({ action: 'stop' as const }));
    kit.deps.onPause = onPause;
    const r = await clipper(kit, {}, (o) => {
      void o;
      return {
        calls: [
          {
            name: 'call_tool',
            input: { name: 'ingest', args: { source: 'https://evil.example/x.mp4' } },
          },
        ],
      };
    });
    expect(onPause).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'source', sources: ['https://evil.example/x.mp4'] }),
    );
    expect(r.done.status).toBe('stopped');
    expect((await kit.engine.getProject(kit.projectId)).media).toHaveLength(1);
  }, 120_000);

  test('--confirm-plan pauses before each plan; Stop applies nothing from it', async () => {
    const kit = await workflowKit();
    const seen: PauseInfo[] = [];
    kit.deps.onPause = (p: PauseInfo) => {
      seen.push(p);
      return Promise.resolve(
        seen.length === 1 ? { action: 'continue' as const } : { action: 'stop' as const },
      );
    };
    const r = await clipper(kit, { mode: 'plan', confirmPlan: true }, planStylist());
    expect(seen.map((p) => p.kind)).toEqual(['plan', 'plan']);
    expect(r.done.status).toBe('stopped');
    const p = await kit.engine.getProject(kit.projectId);
    const [first, second] = r.sequenceIds.map((id) => p.sequences.find((s) => s.id === id)!);
    const scenesOf = (s: typeof first) =>
      s!.videoTracks.flatMap((t) => t.items.filter((i) => i.type === 'scene'));
    expect(scenesOf(first).length).toBeGreaterThan(0);
    expect(scenesOf(second)).toHaveLength(0);
  }, 120_000);

  test('a missing editor role fails at start', async () => {
    const kit = await workflowKit();
    await expect(
      runWorkflow(kit.deps, {
        projectId: kit.projectId,
        workflow: 'clipper',
        message: `make 3 clips from ${FIXTURE_VIDEO}`,
        mode: 'tools',
      }),
    ).rejects.toMatchObject({ code: 'ROLE_MISSING' });
    expect(kit.jobs).toHaveLength(0);
  });
});

describe('tighten list: ranges without words', () => {
  test('a dry-run range with no wordKeys is left out of the list', async () => {
    const kit = await workflowKit();
    const base = buildRegistry(kit.engine);
    kit.deps.registry = {
      ...base,
      get: (name) => {
        const t = base.get(name);
        if (name !== 'remove_pauses' || !t) return t;
        return {
          ...t,
          run: async (ctx, args) => {
            const out = await t.run(ctx, args);
            if (!(args as { dryRun?: boolean }).dryRun) return out;
            const res = out.result as { results: { report?: { ranges?: unknown[] } }[] };
            res.results[0]?.report?.ranges?.push({
              startMs: 0,
              endMs: 400,
              kind: 'pause',
              wordKeys: [],
            });
            return out;
          },
        };
      },
    };
    const seen: PauseInfo[] = [];
    kit.deps.onPause = (p: PauseInfo): Promise<PauseDecision> => {
      seen.push(p);
      return Promise.resolve(p.kind === 'pauses' ? { action: 'continue' } : { action: 'stop' });
    };
    const r = await clipper(kit, { tighten: 'ask', count: 1 });
    expect(r.done.status, r.done.summary).toBe('completed');
    const ranges = seen.filter((p) => p.kind === 'pauses').flatMap((p) => p.ranges ?? []);
    expect(ranges.length).toBeGreaterThan(0);
    for (const x of ranges) expect(typeof x.wordKey, JSON.stringify(x)).toBe('string');
  }, 120_000);
});
