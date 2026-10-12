// Phase 12 steps 1–3 (agent spec "Testing" → mock-model tests): the clipper on the offline fixture
// (20 s talking head, clips of 4–8 s) in tools mode and in plan mode, and checkpoint enforcement.
import { describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.ts';
import { readRunRecord } from '../../src/loop/record.ts';
import { AgentRun, RunStopped } from '../../src/loop/run.ts';
import { buildRegistry } from '../../src/tools/registry.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { workflowJob } from '../../src/workflows/clipper.ts';
import { sceneItems } from '../../src/workflows/stylize.ts';
import { assertClips, CLIP, planStylist, toolsStylist } from '../helpers/stylists.ts';
import { dynamicModel, FIXTURE_VIDEO, role, workflowKit, type Kit } from '../helpers/workflow.ts';

async function clipper(kit: Kit, mode: 'tools' | 'plan', next: ReturnType<typeof toolsStylist>) {
  const m = dynamicModel(next);
  kit.deps.models = { editor: role(m.model) };
  const r = await runWorkflow(kit.deps, {
    projectId: kit.projectId,
    workflow: 'clipper',
    message: `make 3 vox clips from ${FIXTURE_VIDEO}`,
    mode,
    ...CLIP,
    tighten: 'all',
  });
  return { ...r, prompts: m.prompts };
}

describe('clipper (steps 1–2)', () => {
  test('tools mode: 3 clips meeting every checkpoint, one sub-run per clip', async () => {
    const kit = await workflowKit();
    const r = await clipper(kit, 'tools', toolsStylist());
    expect(r.done.status, r.done.summary).toBe('completed');
    const p = await kit.engine.getProject(kit.projectId);
    assertClips(p, r.sequenceIds);
    expect(r.checkpoints.filter((c) => c.status !== 'met')).toEqual([]);
    expect(r.checkpoints).toHaveLength(18);
    // one sub-run per sequence, same runId; every write of the run carries it
    const lines = readRunRecord(r.run.record.path);
    expect(lines.filter((l) => l.type === 'subRun').map((l) => l['subRun'])).toEqual([1, 2, 3]);
    const h = await kit.engine.history(kit.projectId);
    expect(h.length).toBeGreaterThan(1);
    expect(h.every((e) => e.runId === 'run_wftest0001')).toBe(true);
    // the summary has the audio numbers and listen timecodes per clip
    expect(r.done.summary).toMatch(/Clip s1: completed/);
    expect(r.done.summary).toContain('Listen at 00:00.600');
    expect(r.done.summary).toContain('-14.2 LUFS');
  }, 120_000);

  test('plan mode: the same checks from scripted ClipPlans; empty search gives a placeholder', async () => {
    const kit = await workflowKit();
    const r = await clipper(kit, 'plan', planStylist());
    expect(r.done.status, r.done.summary).toBe('completed');
    const p = await kit.engine.getProject(kit.projectId);
    assertClips(p, r.sequenceIds);
    expect(r.checkpoints.filter((c) => c.status !== 'met')).toEqual([]);
    const placeholders = r.sequenceIds.flatMap((id) =>
      sceneItems(p.sequences.find((s) => s.id === id)!).filter(
        (x) => x.item.type === 'scene' && x.item.template === 'base/placeholder',
      ),
    );
    expect(placeholders).toHaveLength(3);
    expect(r.done.summary).toContain('placeholder');
    // the workflow ran review and sound itself in plan mode
    expect(kit.jobs.filter((j) => j.kind === 'audioQa')).toHaveLength(3);
  }, 120_000);
});

describe('checkpoint enforcement (step 3)', () => {
  test('a run whose quick clips skip sourceRange fails with a clear message', async () => {
    const kit = await workflowKit();
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (kind, args) => {
      const out = (await runJob(kind, args)) as { sequenceIds?: string[] };
      if (kind === 'quickClips') {
        await kit.engine.applyOp(
          kit.projectId,
          { op: 'updateSequence', args: { sequenceId: out.sequenceIds![1]!, sourceRange: null } },
          { actor: 'agent', runId: 'run_wftest0001' },
        );
      }
      return out;
    };
    const r = await clipper(kit, 'tools', toolsStylist());
    expect(r.done.status).toBe('failed');
    expect(r.done.error?.code).toBe('CHECKPOINT_MISSED');
    expect(r.done.summary).toMatch(
      /missed required checkpoint: ranges \(s\d: no sourceRange saved\)/,
    );
    // nothing was styled
    expect(r.prompts).toHaveLength(0);
  }, 120_000);
});

/** A stand-in run for workflowJob: project versions read in order, a scripted runJob. */
function fakeRun(versions: number[], runJob: (kind: string) => Promise<unknown>) {
  const reads = [...versions];
  const run = {
    runId: 'run_unit',
    versions: [] as number[],
    record: { write: () => undefined },
    ctx: {
      projectId: 'p_unit',
      seenVersion: 5,
      runJob: (kind: string) => runJob(kind),
      engine: { getProject: () => Promise.resolve({ version: reads.shift() ?? versions.at(-1)! }) },
    },
  };
  return run;
}

describe('workflow jobs (job tools’ rules)', () => {
  test('JOB_CONFLICT runs the job once more', async () => {
    let calls = 0;
    const run = fakeRun([5, 6], () => {
      calls++;
      return calls === 1
        ? Promise.reject(Object.assign(new Error('conflict'), { code: 'JOB_CONFLICT' }))
        : Promise.resolve({ ok: true });
    });
    await expect(workflowJob(run as never, 'quickClips', {})).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test('a user edit before the job: seenVersion is not moved past it', async () => {
    // seen 5; the user wrote 6 before the job started; the job wrote 7
    const run = fakeRun([6, 7], () => Promise.resolve({ ok: true }));
    await workflowJob(run as never, 'quickClips', {});
    expect(run.ctx.seenVersion).toBe(5);
    expect(run.versions).toEqual([7]);
  });

  test('no user edit: seenVersion moves to the job version', async () => {
    const run = fakeRun([5, 7], () => Promise.resolve({ ok: true }));
    await workflowJob(run as never, 'quickClips', {});
    expect(run.ctx.seenVersion).toBe(7);
    expect(run.versions).toEqual([7]);
  });
});

describe('run end status', () => {
  test('an unrelated error after a Stop is a failure, not a stop', async () => {
    const kit = await workflowKit();
    const ac = new AbortController();
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (kind, args, signal) => {
      if (kind !== 'shots') return runJob(kind, args, signal);
      ac.abort();
      throw new VoxError('JOB_FAILED', 'the shots step crashed', 'x');
    };
    kit.deps.models = { editor: role(dynamicModel(toolsStylist()).model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'clipper',
      message: `make 1 vox clip from ${FIXTURE_VIDEO}`,
      mode: 'tools',
      ...CLIP,
      tighten: 'all',
      signal: ac.signal,
    });
    expect(r.done.status).toBe('failed');
    expect(r.done.summary).toContain('the shots step crashed');
  }, 120_000);

  test('a job cancelled by the Stop ends the run as stopped', async () => {
    const kit = await workflowKit();
    const ac = new AbortController();
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (kind, args, signal) => {
      if (kind !== 'shots') return runJob(kind, args, signal);
      ac.abort();
      throw new VoxError('CANCELLED', 'job shots cancelled', 'Run it again when ready.');
    };
    kit.deps.models = { editor: role(dynamicModel(toolsStylist()).model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'clipper',
      message: `make 1 vox clip from ${FIXTURE_VIDEO}`,
      mode: 'tools',
      ...CLIP,
      tighten: 'all',
      signal: ac.signal,
    });
    expect(r.done.status).toBe('stopped');
  }, 120_000);
});

describe('video highlights (D-75, D-86)', () => {
  async function oneClip(kit: Kit) {
    kit.deps.models = { editor: role(dynamicModel(toolsStylist()).model) };
    return runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'clipper',
      message: `make 1 vox clip from ${FIXTURE_VIDEO}`,
      mode: 'tools',
      ...CLIP,
      count: 1,
      tighten: 'all',
    });
  }

  test('the clipper starts the highlights job for its media beside the job chain', async () => {
    const kit = await workflowKit();
    const r = await oneClip(kit);
    expect(r.done.status, r.done.summary).toBe('completed');
    const kinds = kit.jobs.map((j) => j.kind);
    const hl = kit.jobs.find((j) => j.kind === 'highlights');
    const quick = kit.jobs.find((j) => j.kind === 'quickClips');
    expect(hl?.args).toMatchObject({
      projectId: kit.projectId,
      mediaId: quick?.args['mediaId'],
      actor: 'agent',
      runId: 'run_wftest0001',
    });
    // started before the chain it runs beside, and before the pick that reads its output
    expect(kinds.indexOf('highlights')).toBeLessThan(kinds.indexOf('shots'));
    expect(kinds.indexOf('highlights')).toBeLessThan(kinds.indexOf('quickClips'));
    // the test engine has no native helper: the pick goes on without highlights and says so
    expect(r.done.summary).toMatch(/Video highlights: not used \(/);
    const line = readRunRecord(r.run.record.path).find((l) => l.type === 'highlights');
    expect(line).toMatchObject({ mediaId: quick?.args['mediaId'], used: false, skipped: false });
  }, 120_000);

  test('highlights still running after the grace are cancelled; the clips go on without them', async () => {
    const kit = await workflowKit({ highlightsGraceMs: 20 });
    const runJob = kit.deps.runJob!;
    let cancelled = false;
    kit.deps.runJob = async (kind, args, signal) => {
      if (kind !== 'highlights') return runJob(kind, args, signal);
      // a helper that never answers: only the cancel ends it
      return new Promise((_, reject) =>
        signal?.addEventListener('abort', () => {
          cancelled = true;
          reject(new VoxError('CANCELLED', 'Highlights were cancelled.', 'x'));
        }),
      );
    };
    const r = await oneClip(kit);
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(cancelled).toBe(true);
    expect(r.sequenceIds).toHaveLength(1);
    expect(r.done.summary).toMatch(/Video highlights: not used \(still running after 0\.02 s/);
    const line = readRunRecord(r.run.record.path).find((l) => l.type === 'highlights');
    expect(line).toMatchObject({ used: false, skipped: true });
  }, 120_000);

  test('a failed highlights job never fails the run', async () => {
    const kit = await workflowKit();
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (kind, args, signal) => {
      if (kind !== 'highlights') return runJob(kind, args, signal);
      throw new VoxError('TOOL_FAILED', 'the analyzer crashed', 'x');
    };
    const r = await oneClip(kit);
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.done.summary).toContain('Video highlights: not used (the analyzer crashed)');
  }, 120_000);

  test('highlights the helper found are used and reported', async () => {
    const kit = await workflowKit();
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (kind, args, signal) => {
      if (kind !== 'highlights') return runJob(kind, args, signal);
      const mediaId = args['mediaId'] as string;
      return {
        mediaId,
        available: true,
        highlightsPath: `cache/highlights/${mediaId}.json`,
        highlights: 2,
        keyFrameMs: 1500,
        cached: false,
      };
    };
    const r = await oneClip(kit);
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.done.summary).toContain('Video highlights: used (2 ranges)');
    const line = readRunRecord(r.run.record.path).find((l) => l.type === 'highlights');
    expect(line).toMatchObject({ used: true, highlights: 2, skipped: false });
  }, 120_000);
});

describe('workflow calls after a Stop', () => {
  test('workflowCall on a stopped run throws RunStopped and runs no tool', async () => {
    const kit = await workflowKit();
    const base = buildRegistry(kit.engine);
    let ran = 0;
    const registry = {
      ...base,
      get: (name: string) => {
        const t = base.get(name);
        return t && { ...t, run: (...a: Parameters<typeof t.run>) => (ran++, t.run(...a)) };
      },
    };
    const ac = new AbortController();
    const run = await AgentRun.start(
      { ...kit.deps, registry, models: { editor: role(dynamicModel(toolsStylist()).model) } },
      {
        projectId: kit.projectId,
        workflow: 'clipper',
        message: 'x',
        allowedTools: [],
        mode: 'tools',
        signal: ac.signal,
      },
    );
    ac.abort();
    await expect(run.workflowCall('ingest', { source: FIXTURE_VIDEO })).rejects.toBeInstanceOf(
      RunStopped,
    );
    expect(ran).toBe(0);
  });
});
