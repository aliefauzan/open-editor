// Step 13c (D-14): the cue list. Offsets, transition cues at the cut, muted drops, spacing.
import { describe, expect, test } from 'vitest';
import { cueList, cuesJson } from '../../src/audio/cues.ts';
import type { Item, Sequence } from '../../src/model/schema.ts';
import { mapTemplateLookup, type TemplateInfo } from '../../src/ops/templates.ts';
import { emptySequence, F30, NTSC, track } from '../helpers/project.ts';

const tpl = (id: string, kind: TemplateInfo['kind'], sfxCues: TemplateInfo['sfxCues']): TemplateInfo => ({
  id,
  version: '1.0.0',
  kind,
  durationMs: { min: 100, default: 2000, max: 10000 },
  variables: { type: 'object' },
  slots: {},
  sfxCues,
});

const lookup = mapTemplateLookup([
  tpl('t/pop', 'scene', [
    { name: 'in', atMs: 'entrance', sfx: 'pop', type: 'appear' },
    { name: 'land', atMs: 900, sfx: 'thump', type: 'land' },
  ]),
  tpl('t/hero', 'scene', [{ name: 'big', atMs: 0, sfx: 'boom', type: 'hero' }]),
  tpl('t/near', 'scene', [
    { name: 'a', atMs: 0, sfx: 'tap', type: 'cut' },
    { name: 'b', atMs: 50, sfx: 'tap', type: 'cut' },
  ]),
  tpl('t/wipe', 'transition', [{ name: 'whoosh', atMs: 0, sfx: 'whoosh', type: 'move' }]),
]);

const sc = (id: string, template: string, startMs: number, extra: Partial<Item> = {}): Item =>
  ({
    id,
    type: 'scene',
    template,
    templateVersion: '1.0.0',
    startMs,
    durationMs: 2000,
    variables: {},
    ...extra,
  }) as Item;

const seqWith = (items: Item[], extra: Partial<Sequence> = {}): Sequence => ({
  ...emptySequence('seq_c', F30),
  videoTracks: [track('V1', items), track('V2')],
  ...extra,
});

describe('cue list (step 13c)', () => {
  test('numeric and entrance offsets from the item start, on the frame grid', () => {
    const l = cueList(seqWith([sc('it_1', 't/pop', 1000)]), lookup);
    expect(l.cues).toEqual([
      { atMs: 1000, sfx: 'pop', type: 'appear', itemId: 'it_1', cueName: 'in' },
      { atMs: 1900, sfx: 'thump', type: 'land', itemId: 'it_1', cueName: 'land' },
    ]);
    // NTSC: 1000 + 900 ms snaps to frame 57 = 1902 ms
    const n = cueList({ ...seqWith([sc('it_1', 't/pop', 1001)]), canvas: { width: 1080, height: 1920, fps: NTSC } }, lookup);
    expect(n.cues.map((c) => c.atMs)).toEqual([1001, 1902]);
  });

  test('transition cues sit at the cut', () => {
    const items: Item[] = [
      { id: 'it_a', type: 'media', mediaId: 'm_a', startMs: 0, durationMs: 3000, inMs: 0 },
      {
        id: 'it_b',
        type: 'media',
        mediaId: 'm_a',
        startMs: 3000,
        durationMs: 2000,
        inMs: 0,
        transitionIn: { template: 't/wipe', durationMs: 400 },
      },
    ];
    expect(cueList(seqWith(items), lookup).cues).toEqual([
      { atMs: 3000, sfx: 'whoosh', type: 'move', itemId: 'it_b', cueName: 'whoosh' },
    ]);
  });

  test('sfxOff and sequence.sfx false drop cues as muted', () => {
    const off = cueList(seqWith([sc('it_1', 't/pop', 0, { sfxOff: ['land'] } as Partial<Item>)]), lookup);
    expect(off.cues.map((c) => c.cueName)).toEqual(['in']);
    expect(off.dropped).toEqual([{ cue: expect.objectContaining({ cueName: 'land' }), reason: 'muted' }]);
    const none = cueList(seqWith([sc('it_1', 't/pop', 0)], { sfx: false }), lookup);
    expect(none.cues).toEqual([]);
    expect(none.dropped.map((d) => d.reason)).toEqual(['muted', 'muted']);
  });

  test('two cues 50 ms apart: the second is dropped as spacing', () => {
    const l = cueList(seqWith([sc('it_1', 't/near', 0)]), lookup);
    expect(l.cues.map((c) => c.cueName)).toEqual(['a']);
    expect(l.dropped).toEqual([{ cue: expect.objectContaining({ cueName: 'b' }), reason: 'spacing' }]);
  });

  test('two hero cues 3 s apart: the second is dropped as hero-spacing; 4 s apart both stay', () => {
    const l = cueList(seqWith([sc('it_1', 't/hero', 0), sc('it_2', 't/hero', 3000)]), lookup);
    expect(l.cues.map((c) => c.itemId)).toEqual(['it_1']);
    expect(l.dropped).toEqual([{ cue: expect.objectContaining({ itemId: 'it_2' }), reason: 'hero-spacing' }]);
    const ok = cueList(seqWith([sc('it_1', 't/hero', 0), sc('it_2', 't/hero', 4000)]), lookup);
    expect(ok.cues.map((c) => c.itemId)).toEqual(['it_1', 'it_2']);
  });

  test('cues.json is byte-identical on rerun', () => {
    const s = seqWith([sc('it_1', 't/pop', 0), sc('it_2', 't/hero', 2500), sc('it_3', 't/near', 6000)]);
    expect(cuesJson(cueList(s, lookup))).toBe(cuesJson(cueList(structuredClone(s), lookup)));
  });
});
