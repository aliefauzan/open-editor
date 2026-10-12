// Plan-mode scene variety and pictures (D-94, owner report "that vid still not perfect"): the r3 run
// (ollama qwen3.5, attention-compound-r3) planned four `vox/paper-collage` scenes, each with four
// items `media: ""` and no image query, so every scene showed four stills of the speaker herself.
// (a) at most two scenes of a template: the others turn text-led;
// (b) no picture query: one made up from the scene text is searched in the archive before stills;
// (c) a collage that would show more than two stills of the source turns text-led, or keeps two;
// (d) variables that do not fit their template lose the offending keys, not the whole scene.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { sceneItems } from '../../src/workflows/stylize.ts';
import type { ScriptStep } from '../helpers/model.ts';
import { rgbPng } from '../helpers/png.ts';
import { dynamicModel, quickClipsProject, role, viewIn, workflowKit } from '../helpers/workflow.ts';
import type { Kit } from '../helpers/workflow.ts';

interface SceneBeat {
  template: string;
  variables: unknown;
  imageQueries?: string[];
}

/** A ClipPlan with the given scene beats side by side over the middle 80 % of the clip. */
function scenesStylist(scenes: readonly SceneBeat[]) {
  return (o: LanguageModelV4CallOptions): ScriptStep => {
    const { seq, items } = viewIn(o);
    const end = Math.max(...items.map((i) => i.endMs));
    const a = Math.round(end * 0.1);
    const step = Math.floor((end * 0.8) / scenes.length);
    return {
      json: {
        sequences: [
          {
            sequenceId: seq,
            beats: [
              { startMs: 0, endMs: a, kind: 'speaker' },
              ...scenes.map((s, k) => ({
                startMs: a + k * step,
                endMs: a + (k + 1) * step,
                kind: 'scene',
                ...s,
              })),
            ],
          },
        ],
      },
    };
  };
}

async function stylizePlan(kit: Kit, next: ReturnType<typeof scenesStylist>) {
  const { mediaId, sequenceIds } = await quickClipsProject(kit, 1);
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
    ({ item }) => item as { template?: string; variables?: Record<string, unknown> },
  );
  const lines = readRunRecord(r.run.record.path);
  const repairs = (lines.find((l) => l.tool === 'batch' && l['by'] === 'plan')?.['repairs'] ??
    []) as { what: string }[];
  const searched = lines
    .filter((l) => l.tool === 'search_images' && l['by'] === 'plan')
    .map((l) => (l['args'] as { query: string }).query);
  return { r, p, scenes, mediaId, repairs: repairs.map((x) => x.what), lines, searched };
}

/** A local PNG (a new one per call) ingested as the run, standing in for a job that makes a picture. */
function pngJob(kit: Kit, kind: string, calls: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'vox-agent-variety-'));
  const runJob = kit.deps.runJob!;
  kit.deps.runJob = async (k, args, signal) => {
    if (k !== kind) return runJob(k, args, signal);
    calls.push(String(args['candidateId'] ?? args['mediaId']));
    const png = join(dir, `${kind}-${String(calls.length)}.png`);
    const n = calls.length;
    writeFileSync(
      png,
      rgbPng(48, 64, (x, y) => [x * 4, 40 * n, y * 3]),
    );
    const out = (await runJob(
      'ingest',
      { projectId: args['projectId'], inputs: [png], actor: args['actor'], runId: args['runId'] },
      signal,
    )) as { media: { mediaId: string }[] };
    return { mediaId: out.media[0]!.mediaId, reused: false };
  };
}

const items4 = () => [
  { media: '', x: 20, y: 10 },
  { media: '', x: 70, y: 10 },
  { media: '', x: 20, y: 50 },
  { media: '', x: 70, y: 50 },
];

/** The r3 plan: four collages of four empty items, labels only, no queries. */
const R3_SCENES: SceneBeat[] = [
  'Uang Berkurang',
  'Konsep Rezeki',
  'Pintu Rezeki',
  'Kesempatan Baru',
].map((label) => ({ template: 'vox/paper-collage', variables: { items: items4(), label } }));

describe('plan-mode scene variety and pictures (D-94)', () => {
  test('the r3 plan, archive finds nothing: no template more than twice, no wall of stills', async () => {
    const kit = await workflowKit();
    const cut: string[] = [];
    pngJob(kit, 'assets.cutout', cut);
    const { r, p, scenes, repairs, searched } = await stylizePlan(kit, scenesStylist(R3_SCENES));
    expect(r.done.status, r.done.summary).toBe('completed');
    // (a) collages 3 and 4 turn text-led before filling; (c) collages 1 and 2 would show four stills
    // of the speaker each, so they turn text-led too, to the least used text-led templates
    expect(scenes.map((s) => [s.template, s.variables])).toEqual([
      ['base/text-overlay', { text: 'Uang Berkurang' }],
      ['base/title', { title: 'Konsep Rezeki' }],
      ['vox/kinetic-serif', { text: 'Pintu Rezeki' }],
      ['vox/newspaper', { headline: 'Kesempatan Baru' }],
    ]);
    // (b) one archive search per collage left, with its label, before any still
    expect(searched).toEqual(['Uang Berkurang', 'Konsep Rezeki']);
    expect(p.media.filter((m) => m.tags.includes('still'))).toEqual([]);
    expect(cut).toEqual([]);
    expect(repairs).toContain(
      'vox/paper-collage planned 4 times: this one is vox/kinetic-serif "Pintu Rezeki" (at most 2 of a template)',
    );
    expect(repairs).toContain(
      'vox/paper-collage would show only stills of the source: base/text-overlay "Uang Berkurang" instead',
    );
    expect(repairs).toContain(
      'no archive picture for "Uang Berkurang" (query from the scene text)',
    );
    expect(r.checkpoints.find((c) => c.checkpoint === 'fill')?.status).toBe('met');
  }, 120_000);

  test('(b) no picture query: the label finds archive pictures, one search for all items', async () => {
    const kit = await workflowKit();
    kit.search.candidates = [
      { id: 'commons:1', title: 'Coins' },
      { id: 'commons:2', title: 'Market' },
      { id: 'commons:3', title: 'Door' },
    ];
    const fetched: string[] = [];
    const cut: string[] = [];
    pngJob(kit, 'assets.fetch', fetched);
    pngJob(kit, 'assets.cutout', cut);
    const items = [
      { media: '', x: 20, y: 20 },
      { media: '', x: 70, y: 40 },
    ];
    const { r, p, scenes, repairs, searched } = await stylizePlan(
      kit,
      scenesStylist([
        { template: 'vox/paper-collage', variables: { items, label: 'Rezeki Tak Terduga' } },
      ]),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/paper-collage']);
    expect(searched).toEqual(['Rezeki Tak Terduga']);
    // two different candidates, each cut out; no still of the speaker
    expect(fetched).toEqual(['commons:1', 'commons:2']);
    expect(cut).toHaveLength(2);
    expect(p.media.filter((m) => m.tags.includes('still'))).toEqual([]);
    const placed = (scenes[0]!.variables!['items'] as { media: string }[]).map((i) => i.media);
    expect(new Set(placed).size).toBe(2);
    expect(repairs).toContain(
      '2 archive picture(s) for "Rezeki Tak Terduga" (query from the scene text; the plan gave none)',
    );
  }, 120_000);

  test('(c) a collage with an archive picture keeps at most two stills of the source', async () => {
    const kit = await workflowKit();
    kit.search.candidates = [{ id: 'commons:7', title: 'Coins' }];
    const fetched: string[] = [];
    pngJob(kit, 'assets.fetch', fetched);
    pngJob(kit, 'assets.cutout', []);
    const items = [
      { media: '', x: 20, y: 20 },
      { media: 'm1', x: 70, y: 20 },
      { media: 'm1', x: 20, y: 60 },
      { media: 'm1', x: 70, y: 60 },
    ];
    const { r, p, scenes, repairs } = await stylizePlan(
      kit,
      scenesStylist([
        {
          template: 'vox/paper-collage',
          variables: { items, label: 'Kerja' },
          imageQueries: ['old coins'],
        },
      ]),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/paper-collage']);
    const placed = scenes[0]!.variables!['items'] as { media: string; x: number; y: number }[];
    expect(placed.map((i) => [i.x, i.y])).toEqual([
      [20, 20],
      [70, 20],
      [20, 60],
    ]);
    expect(fetched).toEqual(['commons:7']);
    expect(p.media.filter((m) => m.tags.includes('still'))).toHaveLength(2);
    expect(repairs).toContain('items 3: dropped (at most 2 stills of the source video in a scene)');
  }, 120_000);

  test('(d) variables that do not fit lose the offending keys; the scene is not a placeholder', async () => {
    const kit = await workflowKit();
    const { r, scenes, repairs } = await stylizePlan(
      kit,
      scenesStylist([
        {
          template: 'vox/kinetic-serif',
          variables: { text: 'Rezeki tak terduga', align: 'middle', mood: 'calm' },
        },
        {
          template: 'vox/stack',
          variables: {
            panels: [
              { template: 'base/text-overlay', variables: { text: 'Allah', align: 'justify' } },
              { template: 'vox/stat', variables: { value: '80 ribu', tag: 'uang' } },
            ],
          },
        },
      ]),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => [s.template, s.variables])).toEqual([
      ['vox/kinetic-serif', { text: 'Rezeki tak terduga' }],
      [
        'vox/stack',
        {
          panels: [
            { template: 'base/text-overlay', variables: { text: 'Allah' } },
            { template: 'vox/stat', variables: { value: '80 ribu', tag: 'uang' } },
          ],
        },
      ],
    ]);
    expect(repairs).toEqual(
      expect.arrayContaining([
        'align "middle" is not valid, dropped',
        'unknown key "mood" dropped',
        'panel 0: align "justify" is not valid, dropped',
      ]),
    );
    expect(repairs.join(' ')).not.toContain('placeholder');
  }, 120_000);
});
