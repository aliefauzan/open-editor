// Plan-mode scene variety and pictures (D-94, owner report "that vid still not perfect"): the r3 run
// (ollama qwen3.5, attention-compound-r3) planned four `vox/paper-collage` scenes, each with four
// items `media: ""` and no image query, so every scene showed four stills of the speaker herself.
// (a) at most two scenes of a template: the others turn text-led;
// (b) no picture query: one made up from the scene text is searched in the archive before stills;
// (c) a collage that would show more than two stills of the source turns text-led, or keeps two;
// (d) variables that do not fit their template lose the offending keys, not the whole scene.
// (e) D-95, the final demo run: a collage planned with `items: []` and only a label cannot fit its
// template (at least one item); it turns text-led with its label, not a placeholder.
// (f) D-101: with a local image model, a collage the archive cannot fill gets pictures generated in
// the style's look (two per beat), not stills of the speaker or a text card.
// (g) D-102, demo run 5: the model planned six kinetic-serif cards and no picture at all; with an
// image model, the first over-used beats turn into paper-collage scenes with one picture drawn from
// their text (generated before any archive search), the rest text-led.
// (h) D-103, demo run 6: a collage planned with `items: []` and a label, with an image model: one
// centred picture drawn from its label, not a text card (without a model, (e) is unchanged).
// (i) D-106, demo run 7: text cards carried whole spoken sentences; one structured call gives a long
// card a key phrase of its own words (a phrase with other words is refused, the card kept).
// (j) D-106: pictures drawn from filler phrases came out abstract; the same call gives each drawn
// beat a concrete subject, and a varied text-only plan still gets two pictures.
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

/** The stylist, answering the scene-words call (D-106) with `answer` for its beats. */
function withSceneWords(
  stylist: ReturnType<typeof scenesStylist>,
  answer: { beat: number; subject: string; phrase: string }[],
) {
  return (o: LanguageModelV4CallOptions): ScriptStep =>
    JSON.stringify(o.prompt).includes('Scenes:') ? { json: { scenes: answer } } : stylist(o);
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
      // D-96: the overlay's default band (bottom) would sit on the captions, so it moves to the top
      ['base/text-overlay', { text: 'Uang Berkurang', position: 'top' }],
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
    expect(
      repairs.some((w) => w.startsWith('position bottom → top (clear of the captions at')),
    ).toBe(true);
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

  test('(e) a collage with no items turns text-led with its label, not a placeholder', async () => {
    const kit = await workflowKit();
    const { r, scenes, repairs } = await stylizePlan(
      kit,
      scenesStylist([
        { template: 'vox/paper-collage', variables: { items: [], label: 'Peluang baru' } },
        { template: 'vox/paper-collage', variables: { items: [], label: 'Pertolongan Allah' } },
      ]),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes).toHaveLength(2);
    expect(scenes.map((s) => s.template)).not.toContain('base/placeholder');
    expect(scenes.map((s) => s.template)).not.toContain('vox/paper-collage');
    expect(scenes.map((s) => Object.values(s.variables ?? {}))).toEqual([
      ['Peluang baru'],
      ['Pertolongan Allah'],
    ]);
    expect(
      repairs.filter((w) => w.startsWith('vox/paper-collage variables do not fit')),
    ).toHaveLength(2);
    expect(repairs.join(' ')).not.toContain('placeholder');
  }, 120_000);
  test('(f) archive finds nothing, an image model is installed: generated paper pictures', async () => {
    const kit = await workflowKit();
    kit.engine.imageProviders.register({ id: 'fake-gen', generate: async () => '/nowhere.png' });
    const gen: string[] = [];
    const args: Record<string, unknown>[] = [];
    pngJob(kit, 'assets.generate', gen);
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (k, a, signal) => {
      if (k === 'assets.generate') args.push(a);
      return runJob(k, a, signal);
    };
    pngJob(kit, 'assets.cutout', []);
    const { r, p, scenes, repairs } = await stylizePlan(
      kit,
      scenesStylist([
        {
          template: 'vox/paper-collage',
          variables: { items: items4(), label: 'Rezeki Tak Terduga' },
        },
      ]),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/paper-collage']);
    // two generated pictures, square, in the sequence's style; the other two items are stills
    expect(gen).toHaveLength(2);
    for (const a of args) {
      expect(a).toMatchObject({
        prompt: 'An illustration of: Rezeki Tak Terduga',
        styleId: 'vox',
        width: 1024,
        height: 1024,
      });
    }
    expect(p.media.filter((m) => m.tags.includes('still'))).toHaveLength(2);
    expect(repairs).toContain(
      '2 picture(s) generated for "Rezeki Tak Terduga" in the style\'s look',
    );
  }, 120_000);
  test('(g) six text cards, an image model is installed: two turn into drawn pictures', async () => {
    const kit = await workflowKit();
    kit.engine.imageProviders.register({ id: 'fake-gen', generate: async () => '/nowhere.png' });
    const gen: string[] = [];
    const args: Record<string, unknown>[] = [];
    pngJob(kit, 'assets.generate', gen);
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (k, a, signal) => {
      if (k === 'assets.generate') args.push(a);
      return runJob(k, a, signal);
    };
    const cut: string[] = [];
    pngJob(kit, 'assets.cutout', cut);
    const texts = [
      'Tapi menurut gue',
      'Konsep rezeki itu nggak sederhana',
      'Kita nggak pernah tahu',
      'Dijauhkan dari pengeluaran',
      'Pintu yang lebih besar',
      'Lebih besar lagi',
    ];
    const { r, scenes, repairs, searched } = await stylizePlan(
      kit,
      scenesStylist(texts.map((text) => ({ template: 'vox/kinetic-serif', variables: { text } }))),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    // the test clip is about 5 s: the scenes after the third do not fit (dropped, with notes)
    expect(scenes.map((s) => s.template)).toEqual([
      'vox/kinetic-serif',
      'vox/kinetic-serif',
      'vox/paper-collage',
    ]);
    // one centred picture, no label: the captions carry the words
    for (const s of scenes.slice(2)) {
      const v = s.variables as { items: { media: string; x: number; y: number }[]; label?: string };
      expect(v.items).toHaveLength(1);
      expect(v.items[0]).toMatchObject({ x: 50, y: 42, scale: 1.8 });
      expect(v.label).toBeUndefined();
    }
    // drawn from each beat's own text, square for the cutout, before any archive search
    expect(args[0]).toMatchObject({
      prompt: 'An illustration of: Kita nggak pernah tahu',
      styleId: 'vox',
      width: 1024,
      height: 1024,
    });
    expect(searched).toEqual([]);
    expect(cut.length).toBe(gen.length);
    for (const [k, text] of [
      [2, 'Kita nggak pernah tahu'],
      [3, 'Dijauhkan dari pengeluaran'],
    ] as const)
      expect(repairs, String(k)).toContain(
        `vox/kinetic-serif planned 6 times: this one is vox/paper-collage with a picture of "${text}" (at most 2 of a template)`,
      );
    // at most two of a template: the other over-used beats turn text-led
    expect(repairs).toContain(
      'vox/kinetic-serif planned 6 times: this one is vox/newspaper "Pintu yang lebih besar" (at most 2 of a template)',
    );
    expect(repairs).toContain(
      '1 picture(s) generated for "Kita nggak pernah tahu" in the style\'s look',
    );
  }, 120_000);
  test('(h) a collage with no items, an image model is installed: one picture of its label', async () => {
    const kit = await workflowKit();
    kit.engine.imageProviders.register({ id: 'fake-gen', generate: async () => '/nowhere.png' });
    const gen: string[] = [];
    const args: Record<string, unknown>[] = [];
    pngJob(kit, 'assets.generate', gen);
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (k, a, signal) => {
      if (k === 'assets.generate') args.push(a);
      return runJob(k, a, signal);
    };
    const cut: string[] = [];
    pngJob(kit, 'assets.cutout', cut);
    const { r, scenes, repairs, searched } = await stylizePlan(
      kit,
      scenesStylist([
        { template: 'vox/paper-collage', variables: { items: [], label: 'Peluang baru' } },
        { template: 'vox/paper-collage', variables: { items: [], label: 'Pertolongan Allah' } },
      ]),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/paper-collage', 'vox/paper-collage']);
    for (const [k, s] of scenes.entries()) {
      const v = s.variables as { items: { media: string }[]; label: string };
      expect(v.items).toHaveLength(1);
      expect(v.items[0]).toMatchObject({ x: 50, y: 42, scale: 1.8 });
      expect(v.label).toBe(['Peluang baru', 'Pertolongan Allah'][k]);
    }
    expect(args.map((a) => a['prompt'])).toEqual([
      'An illustration of: Peluang baru',
      'An illustration of: Pertolongan Allah',
    ]);
    expect(searched).toEqual([]);
    expect(cut).toHaveLength(2);
    expect(repairs).toContain(
      'vox/paper-collage planned with no items: one picture of "Peluang baru"',
    );
    expect(repairs.join(' ')).not.toContain('do not fit');
  }, 120_000);

  test('(i) a long text card shows its key phrase; a phrase not from the line is refused', async () => {
    const kit = await workflowKit();
    const { r, scenes, repairs, lines } = await stylizePlan(
      kit,
      withSceneWords(
        scenesStylist([
          { template: 'vox/kinetic-serif', variables: { text: 'Tapi menurut gue' } },
          {
            template: 'vox/kinetic-serif',
            variables: { text: 'Konsep rezeki itu nggak sesederhana matematika kita' },
          },
          {
            template: 'vox/newspaper',
            variables: { headline: 'Allah bukain pintu rezeki yang mana buat kita' },
          },
        ]),
        [
          { beat: 2, subject: '', phrase: 'nggak sesederhana matematika' },
          { beat: 3, subject: '', phrase: 'pintu rezeki surga' },
        ],
      ),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.variables)).toEqual([
      { text: 'Tapi menurut gue' },
      { text: 'nggak sesederhana matematika' },
      expect.objectContaining({ headline: expect.stringMatching(/^Allah bukain/) }),
    ]);
    expect(repairs).toContain(
      'vox/kinetic-serif "Konsep rezeki itu nggak sesederhana matematika kita": the key phrase "nggak sesederhana matematika"',
    );
    // the short hook is not asked about
    const asked = lines.find((l) => l.type === 'sceneWords')!;
    expect((asked['asks'] as { beat: number }[]).map((a) => a.beat)).toEqual([2, 3]);
    expect(asked['valid']).toBe(true);
  }, 120_000);

  test('(j) an image model is installed: two text cards become pictures of concrete subjects', async () => {
    const kit = await workflowKit();
    kit.engine.imageProviders.register({ id: 'fake-gen', generate: async () => '/nowhere.png' });
    const gen: string[] = [];
    const args: Record<string, unknown>[] = [];
    pngJob(kit, 'assets.generate', gen);
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (k, a, signal) => {
      if (k === 'assets.generate') args.push(a);
      return runJob(k, a, signal);
    };
    pngJob(kit, 'assets.cutout', []);
    const { r, scenes, repairs, searched } = await stylizePlan(
      kit,
      withSceneWords(
        scenesStylist([
          { template: 'vox/kinetic-serif', variables: { text: 'Tapi menurut gue' } },
          { template: 'vox/newspaper', variables: { headline: 'Kita nggak pernah tahu' } },
          { template: 'vox/kinetic-serif', variables: { text: 'Dijauhkan dari pengeluaran' } },
        ]),
        [
          { beat: 2, subject: 'a closed wooden door in a dark hallway', phrase: '' },
          { beat: 3, subject: 'a hand pushing away a pile of bills', phrase: '' },
        ],
      ),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    // the test clip is about 5 s: the third scene does not fit (dropped, with a note)
    expect(scenes.map((s) => s.template)).toEqual(['vox/kinetic-serif', 'vox/paper-collage']);
    expect(repairs).toContain('dropped: does not fit in the sequence');
    const prompts = args.map((a) => a['prompt']);
    expect(prompts).toContain('An illustration of: a closed wooden door in a dark hallway');
    expect(prompts).toContain('An illustration of: a hand pushing away a pile of bills');
    expect(searched).toEqual([]);
    expect(repairs).toContain(
      'vox/newspaper "Kita nggak pernah tahu": vox/paper-collage with a picture of it instead (at least 2 pictures with an image model)',
    );
  }, 120_000);
});
