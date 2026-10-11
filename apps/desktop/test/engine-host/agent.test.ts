// Phase 13: the agent in the engine host. A run streams `agent.event`s and returns its runId; a
// pause waits for `agent.decide` (plan, pauses and budget pauses), Stop ends a paused run, the
// activity log comes from the run record plus history, "Undo this run" reverts the run's entries
// (UNDO_CONFLICT after a user edit), and the first read of a project closes runs the app left open.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir, setLimits } from '@vox/agent';
import { describe, expect, it, vi } from 'vitest';
import { configDeps } from '../../../../packages/agent/test/helpers/fakes.ts';
import { fixtureProject } from '../../../../packages/agent/test/helpers/project.ts';
import { toolsStylist } from '../../../../packages/agent/test/helpers/stylists.ts';
import {
  dynamicModel,
  FIXTURE_VIDEO,
  role,
  workflowKit,
} from '../../../../packages/agent/test/helpers/workflow.ts';
import type { ScriptStep } from '../../../../packages/agent/test/helpers/model.ts';
import { AgentHost, countIn, lengthIn } from '../../src/engine-host/agent.ts';
import type { AgentPauseData, AgentRunData } from '../../src/shared/api.ts';

type Ev = { name: string; payload: { type?: string; payload?: Record<string, unknown> } };

function host(
  engine: ConstructorParameters<typeof AgentHost>[0]['engine'],
  editor: ReturnType<typeof dynamicModel> | null,
  over: Partial<ConstructorParameters<typeof AgentHost>[0]> = {},
) {
  const events: Ev[] = [];
  const cfg = configDeps();
  let n = 0;
  const h = new AgentHost({
    engine,
    cfg,
    emit: (name, payload) => void events.push({ name, payload: payload as Ev['payload'] }),
    models: () => Promise.resolve({ models: editor ? { editor: role(editor.model) } : {} }),
    newRunId: () => `run_hosttest${String(++n).padStart(4, '0')}`,
    ...over,
  });
  const ofType = (t: string) =>
    events.filter((e) => e.name === 'agent.event' && e.payload.type === t);
  return { h, events, cfg, ofType };
}

const script = (steps: ScriptStep[]) => dynamicModel((_o, n) => steps[n] ?? { text: 'Done.' });

describe('agent host (phase 13)', () => {
  it('reads the clip count and length from the message', () => {
    expect(countIn('make 3 vox clips from https://x.test/v')).toBe(3);
    expect(countIn('make 30 clips')).toBeUndefined();
    expect(lengthIn('clips of 30-60 s')).toEqual([30_000, 60_000]);
    expect(lengthIn('4 to 8 seconds')).toEqual([4_000, 8_000]);
  });

  it('no editor model: ROLE_MISSING before a run starts', async () => {
    const f = await fixtureProject();
    const { h } = host(f.engine, null);
    await expect(
      h.run({ projectId: f.projectId, message: 'make it longer', selection: [] }),
    ).rejects.toMatchObject({ code: 'ROLE_MISSING' });
  });

  it('an edit run streams events, shows in the activity log, and Undo this run reverts it', async () => {
    const f = await fixtureProject();
    await f.engine.applyOp(
      f.projectId,
      {
        op: 'trimItem',
        args: { sequenceId: f.sequenceId, itemId: f.v1, edge: 'end', toMs: 15000 },
      },
      { actor: 'user' },
    );
    const editor = script([
      {
        calls: [
          {
            name: 'trim_item',
            input: { sequenceId: 's1', itemId: 'c1', edge: 'end', toMs: 17000 },
          },
        ],
      },
      { text: 'Made the clip 2 s longer.' },
    ]);
    const { h, ofType } = host(f.engine, editor);
    const r = await h.run({
      projectId: f.projectId,
      message: 'make this longer',
      selection: [f.sequenceId, f.v1],
    });
    expect(r).toMatchObject({ workflow: 'edit', mode: 'tools' });
    await h.idle();
    expect(ofType('agent.started')).toHaveLength(1);
    expect(ofType('agent.done').at(-1)?.payload.payload).toMatchObject({ status: 'completed' });
    const [run] = await h.runs(f.projectId);
    expect(run).toMatchObject<Partial<AgentRunData>>({
      runId: r.runId,
      workflow: 'edit',
      status: 'completed',
      message: 'make this longer',
    });
    expect(run!.changes).toEqual([
      expect.objectContaining({
        op: 'trimItem',
        itemIds: expect.arrayContaining([f.v1]),
        undone: false,
      }),
    ]);
    expect(run!.tools.map((t) => t.tool)).toContain('trim_item');
    await h.undoRun(r.runId);
    const p = await f.engine.getProject(f.projectId);
    const item = p.sequences[0]!.videoTracks.flatMap((t) => t.items).find((i) => i.id === f.v1)!;
    expect(item.startMs + item.durationMs).toBe(15000);
    const [after] = await h.runs(f.projectId);
    expect(after!.changes[0]!.undone).toBe(true);
  });

  it('Undo this run after a user edit of the same item: UNDO_CONFLICT with the item ids', async () => {
    const f = await fixtureProject();
    const editor = script([
      {
        calls: [
          {
            name: 'trim_item',
            input: { sequenceId: 's1', itemId: 'c1', edge: 'end', toMs: 12000 },
          },
        ],
      },
      { text: 'Trimmed.' },
    ]);
    const { h } = host(f.engine, editor);
    const r = await h.run({
      projectId: f.projectId,
      message: 'make this shorter',
      selection: [f.sequenceId, f.v1],
    });
    await h.idle();
    await f.engine.applyOp(
      f.projectId,
      {
        op: 'trimItem',
        args: { sequenceId: f.sequenceId, itemId: f.v1, edge: 'end', toMs: 11000 },
      },
      { actor: 'user' },
    );
    await expect(h.undoRun(r.runId)).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
      details: expect.objectContaining({ itemIds: expect.arrayContaining([f.v1]) }),
    });
  });

  it('confirm plan first: the plan pause reaches the renderer with the plan; Stop applies nothing', async () => {
    const kit = await workflowKit();
    const m = dynamicModel(toolsStylist());
    const { h, ofType } = host(kit.engine, null, {
      models: () => Promise.resolve({ models: { editor: role(m.model) } }),
      runJob: kit.deps.runJob,
    });
    const r = await h.run({
      projectId: kit.projectId,
      message: `make 2 vox clips of 4-8 s from ${FIXTURE_VIDEO}`,
      selection: [],
      mode: 'plan',
      confirmPlan: true,
    });
    expect(r.workflow).toBe('clipper');
    await vi.waitFor(() => expect(ofType('agent.paused').length).toBeGreaterThan(0), {
      timeout: 60_000,
      interval: 50,
    });
    const first = ofType('agent.paused')[0]!.payload.payload as unknown as AgentPauseData;
    expect(first.runId).toBe(r.runId);
    const listed = (await h.runs(kit.projectId)).find((x) => x.runId === r.runId)!;
    expect(listed.status).toBe('paused');
    expect(listed.pause?.reason).toBe(first.reason);
    await h.stop(r.runId);
    await h.idle();
    const done = ofType('agent.done').at(-1)!.payload.payload!;
    expect(done['status']).toBe('stopped');
    await expect(h.decide(r.runId, { approve: true })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  }, 120_000);

  it('a budget pause offers one more default budget; Continue raises the cap', async () => {
    const f = await fixtureProject();
    const steps: ScriptStep[] = Array.from({ length: 6 }, () => ({
      calls: [{ name: 'get_project', input: {} }],
    }));
    const editor = script([...steps, { text: 'Done.' }]);
    const { h, cfg, ofType } = host(f.engine, null, {
      models: () =>
        Promise.resolve({
          models: { editor: role(editor.model, { price: { inPerMTok: 50, outPerMTok: 500 } }) },
        }),
    });
    await setLimits(cfg, { maxUsdPerRun: 3 });
    const r = await h.run({
      projectId: f.projectId,
      message: 'look at the project',
      selection: [f.sequenceId],
    });
    await vi.waitFor(() => expect(ofType('agent.paused').length).toBeGreaterThan(0), {
      timeout: 30_000,
      interval: 20,
    });
    const pause = ofType('agent.paused')[0]!.payload.payload as unknown as AgentPauseData;
    expect(pause).toMatchObject({ reason: 'budget', continueUsd: 6 });
    await h.decide(r.runId, { approve: true });
    await vi.waitFor(() => expect(ofType('agent.done').length).toBeGreaterThan(0), {
      timeout: 30_000,
      interval: 20,
    });
    await h.idle();
    // the bound (about $4.3) fits the raised $6 cap, so the run goes on to the end
    expect(ofType('agent.paused')).toHaveLength(1);
    expect(ofType('agent.done').at(-1)!.payload.payload).toMatchObject({ status: 'completed' });
  }, 60_000);

  it('restart rule: a run left open by a quit shows as stopped on the first read', async () => {
    const f = await fixtureProject();
    const dir = runsDir(f.engine.projectsDir, f.projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'run_leftopen001.jsonl'),
      `${JSON.stringify({
        type: 'started',
        ts: '2026-10-12T10:00:00.000Z',
        runId: 'run_leftopen001',
        workflow: 'edit',
        mode: 'tools',
        message: 'trim it',
      })}\n`,
    );
    const { h } = host(f.engine, null);
    const [run] = await h.runs(f.projectId);
    expect(run).toMatchObject({ runId: 'run_leftopen001', status: 'stopped' });
  });
});
