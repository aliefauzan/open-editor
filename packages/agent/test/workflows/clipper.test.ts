// Phase 12 steps 1–3 (agent spec "Testing" → mock-model tests): the clipper on the offline fixture
// (20 s talking head, clips of 4–8 s) in tools mode and in plan mode, and checkpoint enforcement.
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
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
