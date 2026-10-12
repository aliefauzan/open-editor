// Stack panels in plan mode (D-86 live run): a `vox/stack` scene holds whole scenes in its `panels/*`
// slot (kind `template`), not pictures. The executor fills the panels' own image slots from the
// beat's image queries; an optional panel picture that is not found stays empty (the panel renders
// without it), a required one turns the stack into a placeholder; the fill checkpoint looks inside the
// panels instead of reading each panel as an empty picture slot; and the clip summary names the slots
// the run put pictures in.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { Project } from '@vox/engine';
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { emptySlots, sceneItems } from '../../src/workflows/stylize.ts';
import type { ScriptStep } from '../helpers/model.ts';
import { rgbPng } from '../helpers/png.ts';
import { dynamicModel, quickClipsProject, role, viewIn, workflowKit } from '../helpers/workflow.ts';
import type { Kit } from '../helpers/workflow.ts';

/** A ClipPlan with one stack scene over the middle of the clip. */
function stackStylist(panels: unknown[], imageQueries: string[]) {
  return (o: LanguageModelV4CallOptions): ScriptStep => {
    const { seq, items } = viewIn(o);
    const end = Math.max(...items.map((i) => i.endMs));
    const a = Math.round(end * 0.2);
    const b = Math.round(end * 0.8);
    return {
      json: {
        sequences: [
          {
            sequenceId: seq,
            beats: [
              { startMs: 0, endMs: a, kind: 'speaker' },
              {
                startMs: a,
                endMs: b,
                kind: 'scene',
                template: 'vox/stack',
                variables: { panels, bg: 'paper' },
                imageQueries,
              },
              { startMs: b, endMs: end, kind: 'speaker' },
            ],
          },
        ],
      },
    };
  };
}

// the D-86 plan (qwen3.5): a newspaper panel without its photo and a kinetic-serif panel
const D86_PANELS = [
  {
    template: 'vox/newspaper',
    variables: { headline: 'Kerja Tak Terbayang', subhead: 'Peluang baru', bg: 'paper' },
  },
  {
    template: 'vox/kinetic-serif',
    variables: { text: 'Bisnis tiba-tiba berkembang', bg: 'highlight' },
  },
];
const D86_QUERIES = ['office job offer letter', 'sudden business growth graph'];

async function stylizePlan(kit: Kit, next: ReturnType<typeof stackStylist>) {
  const { sequenceIds } = await quickClipsProject(kit, 1);
  const m = dynamicModel(next);
  kit.deps.models = { editor: role(m.model) };
  const r = await runWorkflow(kit.deps, {
    projectId: kit.projectId,
    workflow: 'stylize',
    message: '',
    mode: 'plan',
    sequenceIds,
  });
  const p = await kit.engine.getProject(kit.projectId);
  const s = p.sequences.find((x) => x.id === sequenceIds[0])!;
  const scenes = sceneItems(s).map(
    ({ item }) => item as { template?: string; variables?: unknown },
  );
  return { r, p, scenes };
}

/** Archive "downloads" become a local PNG ingested as the run (no network). */
function offlineFetch(kit: Kit) {
  const png = join(mkdtempSync(join(tmpdir(), 'vox-agent-panel-')), 'office.png');
  writeFileSync(
    png,
    rgbPng(64, 48, (x, y) => [x * 3, y * 4, 90]),
  );
  kit.search.candidates = [{ id: 'commons:42', title: 'Office letter' }];
  const runJob = kit.deps.runJob!;
  kit.deps.runJob = async (kind, args, signal) => {
    if (kind !== 'assets.fetch') return runJob(kind, args, signal);
    const out = (await runJob(
      'ingest',
      { projectId: args['projectId'], inputs: [png], actor: args['actor'], runId: args['runId'] },
      signal,
    )) as { media: { mediaId: string }[] };
    return { mediaId: out.media[0]!.mediaId, reused: false };
  };
}

describe('stack panels in plan mode (D-86)', () => {
  test('the D-86 plan: no picture found, the newspaper panel stays without photo, fill is met', async () => {
    const kit = await workflowKit();
    const { r, scenes } = await stylizePlan(kit, stackStylist(D86_PANELS, D86_QUERIES));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.checkpoints.find((c) => c.checkpoint === 'fill')?.status).toBe('met');
    // the stack is kept with both panels as planned (no photo invented, no placeholder)
    expect(scenes.map((s) => s.template)).toEqual(['vox/stack']);
    expect(scenes[0]!.variables).toEqual({ panels: D86_PANELS, bg: 'paper' });
    // the panel's photo was searched for with the beat's first query; the repair says it stayed empty
    const lines = readRunRecord(r.run.record.path);
    const searched = lines
      .filter((l) => l.tool === 'search_images' && l['by'] === 'plan')
      .map((l) => (l['args'] as { query: string }).query);
    expect(searched).toEqual(['office job offer letter']);
    const batch = lines.find((l) => l.tool === 'batch' && l['by'] === 'plan');
    expect(JSON.stringify(batch?.['repairs'])).toContain(
      'panel 0: no picture for office job offer letter, photo left empty',
    );
  }, 120_000);

  test('a picture found for a panel slot fills it; the summary names the slot', async () => {
    const kit = await workflowKit();
    offlineFetch(kit);
    const { r, p, scenes } = await stylizePlan(kit, stackStylist(D86_PANELS, D86_QUERIES));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.checkpoints.find((c) => c.checkpoint === 'fill')).toMatchObject({
      status: 'met',
      note: 'all slots filled',
    });
    const panels = (scenes[0]!.variables as { panels: { variables: Record<string, unknown> }[] })
      .panels;
    const photo = panels[0]!.variables['photo'];
    expect(p.media.find((m) => m.id === photo)?.kind).toBe('image');
    expect(panels[1]!.variables).toEqual(D86_PANELS[1]!.variables);
    expect(r.done.summary).toMatch(/Pictures added by the run: c\d+ panels\/0\/photo\./);
  }, 120_000);

  test('a required panel picture that is not found turns the stack into a placeholder', async () => {
    const kit = await workflowKit();
    const panels = [
      { template: 'vox/framed-portrait', variables: {} },
      { template: 'vox/kinetic-serif', variables: { text: 'Two panels' } },
    ];
    const { r, scenes } = await stylizePlan(kit, stackStylist(panels, ['a portrait of a judge']));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => [s.template, s.variables])).toEqual([
      ['base/placeholder', { label: 'Picture: a portrait of a judge' }],
    ]);
  }, 120_000);
});

describe('fill checkpoint slots (D-86)', () => {
  const slots: Record<string, Record<string, string>> = {
    'vox/stack': { 'panels/*': 'template' },
    'vox/newspaper': { photo: 'image' },
    'vox/kinetic-serif': {},
    'vox/framed-portrait': { media: 'image' },
  };
  const lookup = (id: string) => (slots[id] ? { slots: slots[id] } : undefined);
  const p = { media: [{ id: 'm_img', kind: 'image' }] } as unknown as Project;

  test('a template slot is checked by its panels’ own slots, not as a picture', () => {
    const vars = {
      panels: [
        { template: 'vox/kinetic-serif', variables: { text: 'x' } },
        { template: 'vox/newspaper', variables: { headline: 'h' } },
        { template: 'vox/framed-portrait', variables: { media: 'm_img' } },
      ],
    };
    expect(emptySlots(p, slots['vox/stack']!, vars, lookup)).toEqual([]);
  });

  test('a panel slot that names no project media is reported with its full path', () => {
    const vars = {
      panels: [
        { template: 'vox/newspaper', variables: { headline: 'h', photo: 'a newspaper' } },
        { template: 'vox/framed-portrait', variables: { media: 'm_img' } },
      ],
    };
    expect(emptySlots(p, slots['vox/stack']!, vars, lookup)).toEqual(['panels/0/photo']);
  });
});
