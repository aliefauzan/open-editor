// Step 9: plan mode. A valid plan becomes one `batch`; an invalid one goes back with the zod error
// (2 retries, then PLAN_INVALID); ClipPlan repairs clamp durations and drop beats; an empty image
// search with no image provider gives a placeholder scene; confirm-plan pauses before anything runs.
import { mapTemplateLookup, type TemplateInfo } from '@vox/engine';
import { describe, expect, test, vi } from 'vitest';
import { ClipPlanSchema } from '../../src/loop/plan.ts';
import { runAgent } from '../../src/loop/run.ts';
import { readRunRecord } from '../../src/loop/record.ts';
import type { AgentEngine } from '../../src/tools/types.ts';
import { promptText, roleModel, runDeps, scriptedModel } from '../helpers/model.ts';
import { TEMPLATES, fixtureProject, type Fixture } from '../helpers/project.ts';

const PLAN_TEMPLATES: TemplateInfo[] = [
  ...TEMPLATES,
  {
    id: 'base/photo',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 1000, default: 3000, max: 6000 },
    variables: {
      type: 'object',
      properties: { image: { type: 'string' }, caption: { type: 'string' } },
      required: ['image'],
      additionalProperties: false,
    },
    slots: { image: 'image' },
  },
  {
    id: 'base/placeholder',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 500, default: 3000, max: 30000 },
    variables: {
      type: 'object',
      properties: { label: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['label'],
      additionalProperties: false,
    },
    slots: {},
  },
  {
    id: 'base/collage',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 1000, default: 3000, max: 6000 },
    variables: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { media: { type: 'string', minLength: 1, maxLength: 64 } },
            required: ['media'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    slots: { 'items/*/media': 'cutout' },
  },
];

const lookup = mapTemplateLookup(PLAN_TEMPLATES);

/** The engine with a fake job runner: archive search finds nothing. */
function withJobs(
  f: Fixture,
  results: Record<string, unknown> = { 'assets.search': { candidates: [] } },
) {
  const started: { kind: string; args: unknown }[] = [];
  const jobs = {
    start: (kind: string, args: unknown) => {
      started.push({ kind, args });
      return `job_${String(started.length)}`;
    },
    wait: (id: string) => {
      const kind = started[Number(id.slice(4)) - 1]!.kind;
      return Promise.resolve({ id, kind, status: 'done', result: results[kind] ?? {} });
    },
    cancel: () => undefined,
  };
  const engine = Object.assign(Object.create(f.engine) as AgentEngine, { jobs });
  return { engine, started };
}

const req = (f: Fixture, over: Record<string, unknown> = {}) => ({
  projectId: f.projectId,
  workflow: 'freeform',
  message: 'make it quieter',
  allowedTools: [],
  mode: 'plan' as const,
  scope: [f.sequenceId],
  ...over,
});

describe('plan mode (step 9)', () => {
  test('ClipPlan: an empty template on a speaker beat is accepted (guided generation fills every field)', () => {
    // The Apple on-device model's answer to the probe's plan task (recorded on the M5, phase 11).
    const beat = (kind: 'speaker' | 'scene', template: string) => ({
      startMs: 0,
      endMs: 500,
      kind,
      template,
      variables: {},
      imageQueries: [],
    });
    const plan = (b: ReturnType<typeof beat>) => ({
      sequences: [{ sequenceId: 's1', beats: [b] }],
    });
    expect(ClipPlanSchema.safeParse(plan(beat('speaker', ''))).success).toBe(true);
    expect(ClipPlanSchema.safeParse(plan(beat('scene', 'base/title'))).success).toBe(true);
    const scene = ClipPlanSchema.safeParse(plan(beat('scene', '')));
    expect(scene.success).toBe(false);
    expect(scene.error?.issues[0]?.message).toBe('a scene beat needs a template');
  });

  test('a valid op-list plan runs as one batch by the agent', async () => {
    const f = await fixtureProject();
    const m = scriptedModel([
      {
        json: {
          ops: [{ op: 'updateClip', args: { sequenceId: 's1', itemId: 'c1', volume: 0.5 } }],
        },
      },
    ]);
    const { deps } = runDeps(f, roleModel(m.model));
    const { done, run } = await runAgent(deps, req(f));
    expect(done.status).toBe('completed');
    const last = (await f.engine.history(f.projectId)).at(-1)!;
    expect(last).toMatchObject({ actor: 'agent', runId: run.runId, op: 'batch' });
    expect(promptText(m.prompts[0]!)).toContain('Sequence s1 @v');
  });

  test('an invalid plan goes back with the zod error; the second answer runs', async () => {
    const f = await fixtureProject();
    const m = scriptedModel([
      {
        json: {
          ops: [{ op: 'updateClip', args: { sequenceId: 's1', itemId: 'c1', volume: 'loud' } }],
        },
      },
      {
        json: {
          ops: [{ op: 'updateClip', args: { sequenceId: 's1', itemId: 'c1', volume: 0.4 } }],
        },
      },
    ]);
    const { deps } = runDeps(f, roleModel(m.model));
    const { done } = await runAgent(deps, req(f));
    expect(done.status).toBe('completed');
    expect(promptText(m.prompts[1]!)).toMatch(/ops\.0 \(updateClip\): volume/);
  });

  test('after 2 retries the run fails with PLAN_INVALID and nothing applied', async () => {
    const f = await fixtureProject();
    const bad = { json: { ops: [{ op: 'noSuchOp', args: {} }] } };
    const m = scriptedModel([bad, bad, bad, bad]);
    const before = (await f.engine.history(f.projectId)).length;
    const { deps } = runDeps(f, roleModel(m.model));
    const { done } = await runAgent(deps, req(f));
    expect(done).toMatchObject({ status: 'failed', error: { code: 'PLAN_INVALID' } });
    expect(m.prompts).toHaveLength(3);
    expect((await f.engine.history(f.projectId)).length).toBe(before);
  });

  test('ClipPlan: durations clamped, unknown template dropped, empty search → placeholder', async () => {
    const f = await fixtureProject({ engine: { templates: lookup } });
    const { engine, started } = withJobs(f);
    const m = scriptedModel([
      {
        json: {
          sequences: [
            {
              sequenceId: 's1',
              beats: [
                { startMs: 0, endMs: 2000, kind: 'speaker' },
                {
                  startMs: 2000,
                  endMs: 30000,
                  kind: 'scene',
                  template: 'base/title',
                  variables: { title: 'Hi' },
                },
                {
                  startMs: 13000,
                  endMs: 15000,
                  kind: 'scene',
                  template: 'base/nope',
                  variables: {},
                },
                {
                  startMs: 15000,
                  endMs: 17000,
                  kind: 'scene',
                  template: 'base/photo',
                  imageQueries: ['lighthouse at dusk'],
                },
              ],
            },
          ],
        },
      },
    ]);
    const { deps } = runDeps(f, roleModel(m.model), { engine, templates: lookup });
    const { done, run } = await runAgent(deps, req(f, { planKind: 'clip' }));
    expect(done.status).toBe('completed');
    expect(started.map((s) => s.kind)).toEqual(['assets.search']);
    const seq = (await f.engine.getProject(f.projectId)).sequences[0]!;
    const scenes = seq.videoTracks.find((t) => t.id === 'V2')!.items;
    expect(
      scenes.map((s) => [s.startMs, s.durationMs, (s as { template?: string }).template]),
    ).toEqual([
      [2000, 10000, 'base/title'],
      [15000, 2000, 'base/placeholder'],
    ]);
    expect(JSON.stringify(scenes[1])).toContain('Picture: lighthouse at dusk');
    const rec = readRunRecord(run.record.path).find((l) => l.tool === 'batch');
    expect(JSON.stringify(rec?.['repairs'])).toMatch(
      /duration clamped.*dropped: base\/nope.*placeholder/,
    );
  });

  test('ClipPlan: pictures inside an array are searched for (query, else the text written there)', async () => {
    const f = await fixtureProject({ engine: { templates: lookup } });
    const { engine, started } = withJobs(f);
    const collage = (startMs: number, media: string, imageQueries?: string[]) => ({
      startMs,
      endMs: startMs + 2000,
      kind: 'scene',
      template: 'base/collage',
      variables: { items: [{ media }] },
      ...(imageQueries && { imageQueries }),
    });
    const m = scriptedModel([
      {
        json: {
          sequences: [
            {
              sequenceId: 's1',
              beats: [
                collage(2000, '', ['old harbour']),
                collage(5000, 'a red bank card'),
                collage(8000, 'm1'),
              ],
            },
          ],
        },
      },
    ]);
    const { deps } = runDeps(f, roleModel(m.model), { engine, templates: lookup });
    const { done } = await runAgent(deps, req(f, { planKind: 'clip' }));
    expect(done.status, done.summary).toBe('completed');
    expect(started.map((s) => (s.args as { query?: string }).query)).toEqual([
      'old harbour',
      'a red bank card',
    ]);
    const seq = (await f.engine.getProject(f.projectId)).sequences[0]!;
    const labels = seq.videoTracks
      .find((t) => t.id === 'V2')!
      .items.map((s) => (s as { variables?: { label?: string } }).variables?.label);
    expect(labels).toEqual([
      'Picture: old harbour',
      'Picture: a red bank card',
      'Picture: items media',
    ]);
  });

  test('ClipPlan: a scene whose variables do not fit its template becomes a placeholder', async () => {
    const f = await fixtureProject({ engine: { templates: lookup } });
    const m = scriptedModel([
      {
        json: {
          sequences: [
            {
              sequenceId: 's1',
              beats: [
                // a collage without its required `items`: the batch would fail as a whole
                { startMs: 1000, endMs: 3000, kind: 'scene', template: 'base/collage' },
                {
                  startMs: 5000,
                  endMs: 7000,
                  kind: 'scene',
                  template: 'base/title',
                  variables: { title: 'Kept' },
                },
              ],
            },
          ],
        },
      },
    ]);
    const { deps } = runDeps(f, roleModel(m.model), { templates: lookup });
    const { done, run } = await runAgent(deps, req(f, { planKind: 'clip' }));
    expect(done.status, done.summary).toBe('completed');
    expect(m.prompts).toHaveLength(1);
    const seq = (await f.engine.getProject(f.projectId)).sequences[0]!;
    const scenes = seq.videoTracks.find((t) => t.id === 'V2')!.items as {
      template?: string;
      variables?: Record<string, unknown>;
    }[];
    expect(scenes.map((s) => [s.template, s.variables])).toEqual([
      ['base/placeholder', { label: 'Scene: base/collage' }],
      ['base/title', { title: 'Kept' }],
    ]);
    const rec = readRunRecord(run.record.path).find((l) => l.tool === 'batch');
    expect(JSON.stringify(rec?.['repairs'])).toMatch(
      /placeholder: base\/collage variables do not fit \(.*items/,
    );
  });

  test('ClipPlan: a beat that does not end after its start is dropped, the rest applies', async () => {
    const f = await fixtureProject({ engine: { templates: lookup } });
    const beat = (startMs: number, endMs: number, title: string) => ({
      startMs,
      endMs,
      kind: 'scene',
      template: 'base/title',
      variables: { title },
    });
    const m = scriptedModel([
      {
        json: {
          sequences: [
            {
              sequenceId: 's1',
              beats: [
                { startMs: 4000, endMs: 4000, kind: 'speaker' },
                beat(2000, 4000, 'Kept'),
                beat(6000, 6000, 'Empty'),
                beat(9000, 7000, 'Backwards'),
              ],
            },
          ],
        },
      },
    ]);
    const { deps } = runDeps(f, roleModel(m.model), { templates: lookup });
    const { done, run } = await runAgent(deps, req(f, { planKind: 'clip' }));
    expect(done.status, done.summary).toBe('completed');
    expect(m.prompts).toHaveLength(1);
    const seq = (await f.engine.getProject(f.projectId)).sequences[0]!;
    const scenes = seq.videoTracks.find((t) => t.id === 'V2')!.items;
    expect(scenes.map((s) => [s.startMs, s.durationMs])).toEqual([[2000, 2000]]);
    const rec = readRunRecord(run.record.path).find((l) => l.tool === 'batch');
    expect(JSON.stringify(rec?.['repairs'])).toMatch(
      /dropped: ends at 6000.*dropped: ends at 7000/,
    );
  });

  test('ClipPlan with nothing to apply: the retry says why each beat was dropped, no empty track', async () => {
    const f = await fixtureProject({ engine: { templates: lookup } });
    const tracksBefore = (await f.engine.getProject(f.projectId)).sequences[0]!.videoTracks.length;
    const plan = (template: string) => ({
      sequences: [
        {
          sequenceId: 's1',
          beats: [
            { startMs: 0, endMs: 2000, kind: 'speaker' },
            { startMs: 2000, endMs: 4000, kind: 'scene', template, variables: { title: 'Two' } },
          ],
        },
      ],
    });
    // a caption preset is not a scene template: the beat is dropped and the plan is empty
    const m = scriptedModel([{ json: plan('vox/word-reveal') }, { json: plan('base/title') }]);
    const { deps } = runDeps(f, roleModel(m.model), { templates: lookup });
    const { done } = await runAgent(deps, req(f, { planKind: 'clip' }));
    expect(done.status, done.summary).toBe('completed');
    expect(m.prompts).toHaveLength(2);
    expect(promptText(m.prompts[1]!)).toMatch(
      /nothing to apply\. Plan at least one change\. Scene beats not applied: vox\/word-reveal is not a scene template/,
    );
    const seq = (await f.engine.getProject(f.projectId)).sequences[0]!;
    expect(seq.videoTracks).toHaveLength(Math.max(tracksBefore, 2));
    expect(seq.videoTracks.flatMap((t) => t.items).filter((i) => i.type === 'scene')).toHaveLength(
      1,
    );
  });

  test('confirm plan: pauses (approval, kind plan); stop applies nothing', async () => {
    const f = await fixtureProject();
    const m = scriptedModel([
      {
        json: {
          ops: [{ op: 'updateClip', args: { sequenceId: 's1', itemId: 'c1', volume: 0.5 } }],
        },
      },
    ]);
    const onPause = vi.fn(() => Promise.resolve({ action: 'stop' as const }));
    const before = (await f.engine.history(f.projectId)).length;
    const { deps, events } = runDeps(f, roleModel(m.model), { onPause });
    const { done } = await runAgent(deps, req(f, { confirmPlan: true }));
    expect(onPause).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'approval', kind: 'plan' }),
    );
    expect(events.find((e) => e.type === 'agent.paused')?.payload).toMatchObject({ kind: 'plan' });
    expect(done.status).toBe('stopped');
    expect((await f.engine.history(f.projectId)).length).toBe(before);
  });
});
