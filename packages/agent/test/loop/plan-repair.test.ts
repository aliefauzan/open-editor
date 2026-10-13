// Deterministic ClipPlan repairs (D-94): variables fitted to their template (the D-90 open item) and
// scene variety (owner report "that vid still not perfect": four paper-collage scenes in a row).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapTemplateLookup, type TemplateInfo } from '@vox/engine';
import { describe, expect, test } from 'vitest';
import {
  MAX_SAME_TEMPLATE,
  MIN_PICTURE_LED,
  clearOfCaptions,
  fitVariables,
  pictureAboveCaptions,
  pictureLedTemplate,
  textLedTemplates,
  varySceneTemplates,
  type VaryBeat,
} from '../../src/loop/plan-repair.ts';
import { REPO } from '../helpers/kit.ts';

/** A repo template as the engine reads it (id `<style>/<name>`). */
function repoTemplate(id: string): TemplateInfo {
  const [style, name] = id.split('/') as [string, string];
  const raw = JSON.parse(
    readFileSync(join(REPO, 'styles', style, 'templates', name, 'template.json'), 'utf8'),
  ) as Omit<TemplateInfo, 'id'>;
  return { ...raw, id };
}

const IDS = [
  'vox/framed-portrait',
  'vox/kinetic-serif',
  'vox/map-route',
  'vox/newspaper',
  'vox/paper-collage',
  'vox/stack',
  'vox/stat',
  'vox/year-card',
  'base/placeholder',
  'base/text-overlay',
  'base/title',
];
const templates = mapTemplateLookup(IDS.map(repoTemplate));
const get = (id: string) => templates.get(id)!;

function fit(id: string, variables: Record<string, unknown>) {
  const notes: string[] = [];
  const out = fitVariables(get(id), variables, templates, (w) => notes.push(w));
  return { out, notes };
}

describe('plan variables repair (D-94, the D-90 open item)', () => {
  test('unknown keys on collage items are dropped, each with a note (D-90 live run 3)', () => {
    const { out, notes } = fit('vox/paper-collage', {
      items: [
        { media: 'img1', x: 20, y: 30, label: 'kerja' },
        { media: 'img2', x: 60, y: 40 },
      ],
      label: 'Pintu Rezeki',
    });
    expect(out).toEqual({
      items: [
        { media: 'img1', x: 20, y: 30 },
        { media: 'img2', x: 60, y: 40 },
      ],
      label: 'Pintu Rezeki',
    });
    expect(notes).toEqual(['items 0: unknown key "label" dropped']);
  });

  test('an invalid optional value is dropped; an unknown top-level key too', () => {
    const { out, notes } = fit('vox/kinetic-serif', {
      text: 'Rezeki tak terduga',
      align: 'middle',
      bg: 'paper',
      mood: 'calm',
    });
    expect(out).toEqual({ text: 'Rezeki tak terduga', bg: 'paper' });
    expect(notes).toEqual(['align "middle" is not valid, dropped', 'unknown key "mood" dropped']);
  });

  test('stack panels are fitted to their own templates (an invalid align on a text overlay)', () => {
    const { out, notes } = fit('vox/stack', {
      panels: [
        { template: 'base/text-overlay', variables: { text: 'Allah', align: 'justify' } },
        { template: 'vox/stat', variables: { value: '80 ribu', tag: 'uang', size: 3 } },
      ],
    });
    expect(out).toEqual({
      panels: [
        { template: 'base/text-overlay', variables: { text: 'Allah' } },
        { template: 'vox/stat', variables: { value: '80 ribu', tag: 'uang' } },
      ],
    });
    expect(notes).toEqual([
      'panel 0: align "justify" is not valid, dropped',
      'panel 1: unknown key "size" dropped',
    ]);
  });

  test('optional values out of range and nested objects that do not fit are dropped', () => {
    const { out, notes } = fit('vox/paper-collage', {
      items: [{ media: 'img1', x: 20, y: 30, scale: 7 }],
      grade: 'neon',
      clipping: { kicker: 'x' },
    });
    expect(out).toEqual({ items: [{ media: 'img1', x: 20, y: 30 }] });
    expect(notes).toEqual([
      'items 0 scale 7 is not valid, dropped',
      'grade "neon" is not valid, dropped',
      'clipping {"kicker":"x"} is not valid, dropped',
    ]);
  });

  test('array entries that do not fit are dropped while the minimum holds; over the maximum too', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ media: `img${String(i)}`, x: 10, y: 10 }));
    const { out, notes } = fit('vox/paper-collage', {
      items: [{ media: 'img9', x: 'left', y: 10 }, ...items],
    });
    expect((out['items'] as unknown[]).length).toBe(6);
    expect(notes).toEqual([
      'items 0 {"media":"img9","x":"left","y":10} is not valid, dropped',
      'items 7, 8 dropped (at most 6)',
    ]);
  });

  test('a required value that does not fit is left for the engine check (no note)', () => {
    const { out, notes } = fit('vox/kinetic-serif', { text: 42, align: 'left' });
    expect(out).toEqual({ text: 42, align: 'left' });
    expect(notes).toEqual([]);
    // the only collage item is invalid: kept, the array would go under its minimum
    const one = fit('vox/paper-collage', { items: [{ media: 'img1', x: 'left', y: 10 }] });
    expect(one.out).toEqual({ items: [{ media: 'img1', x: 'left', y: 10 }] });
    expect(one.notes).toEqual([]);
  });
});

describe('scene variety (D-94)', () => {
  const textLed = textLedTemplates(IDS, templates);

  test('text-led templates: one required free text of 40+ characters; the style first', () => {
    expect(textLed).toEqual([
      { id: 'vox/kinetic-serif', key: 'text' },
      { id: 'vox/newspaper', key: 'headline' },
      { id: 'base/text-overlay', key: 'text' },
      { id: 'base/title', key: 'title' },
    ]);
  });

  const collage = (startMs: number, label: string, imageQueries?: string[]): VaryBeat => ({
    startMs,
    endMs: startMs + 2000,
    kind: 'scene',
    template: 'vox/paper-collage',
    variables: { items: [{ media: '', x: 20, y: 10 }], label },
    ...(imageQueries && { imageQueries }),
  });

  test('the live r3 plan: four collages, the last two turn text-led', () => {
    const beats: VaryBeat[] = [
      { startMs: 0, endMs: 1400, kind: 'speaker' },
      collage(1400, 'Uang Berkurang'),
      collage(3500, 'Konsep Rezeki'),
      collage(6800, 'Pintu Rezeki'),
      collage(9200, 'Kesempatan Baru'),
    ];
    const r = varySceneTemplates(beats, textLed, templates);
    expect(r.beats.map((b) => [b.template, b.variables])).toEqual([
      [undefined, undefined],
      ['vox/paper-collage', beats[1]!.variables],
      ['vox/paper-collage', beats[2]!.variables],
      ['vox/kinetic-serif', { text: 'Pintu Rezeki' }],
      ['vox/newspaper', { headline: 'Kesempatan Baru' }],
    ]);
    expect(r.notes).toEqual([
      {
        beat: 3,
        what: 'vox/paper-collage planned 4 times: this one is vox/kinetic-serif "Pintu Rezeki" (at most 2 of a template)',
      },
      {
        beat: 4,
        what: 'vox/paper-collage planned 4 times: this one is vox/newspaper "Kesempatan Baru" (at most 2 of a template)',
      },
    ]);
    expect(r.counts.get('vox/paper-collage')).toBe(MAX_SAME_TEMPLATE);
  });

  test('beats with picture queries keep the template first; a beat with no text stays', () => {
    const beats: VaryBeat[] = [
      collage(0, 'Satu'),
      collage(3000, 'Dua', ['a market stall']),
      collage(6000, 'Tiga', ['old coins']),
      { ...collage(9000, ''), variables: { items: [{ media: '', x: 1, y: 1 }] } },
    ];
    const r = varySceneTemplates(beats, textLed, templates);
    expect(r.beats.map((b) => b.template)).toEqual([
      'vox/kinetic-serif',
      'vox/paper-collage',
      'vox/paper-collage',
      'vox/paper-collage',
    ]);
    expect(r.beats[0]!.imageQueries).toBeUndefined();
  });

  test('no text-led template in the style, or two of a template: the plan is kept', () => {
    const beats = [collage(0, 'A b'), collage(3000, 'C d'), collage(6000, 'E f')];
    expect(varySceneTemplates(beats, [], templates).beats).toEqual(beats);
    expect(varySceneTemplates(beats.slice(0, 2), textLed, templates).notes).toEqual([]);
  });

  // D-102, demo run 5: six kinetic-serif cards and no picture; with an image model installed the
  // first over-used beats turn into the style's picture-led template with one empty, centred entry
  test('picture-led: the collage of the style, one centred picture per over-used beat', () => {
    const pic = pictureLedTemplate(IDS, templates);
    expect(pic).toEqual({ id: 'vox/paper-collage', arr: 'items', field: 'media' });
    const card = (startMs: number, text: string): VaryBeat => ({
      startMs,
      endMs: startMs + 2000,
      kind: 'scene',
      template: 'vox/kinetic-serif',
      variables: { text },
    });
    const beats = ['Satu dua', 'Tiga empat', 'Lima enam', 'Tujuh', 'Delapan', 'Sembilan'].map(
      (text, k) => card(k * 3000, text),
    );
    const r = varySceneTemplates(beats, textLed, templates, pic);
    expect(r.beats.map((b) => b.template)).toEqual([
      'vox/kinetic-serif',
      'vox/kinetic-serif',
      'vox/paper-collage',
      'vox/paper-collage',
      'vox/newspaper',
      'base/text-overlay',
    ]);
    expect(r.beats[2]!.variables).toEqual({ items: [{ media: '', x: 50, y: 42, scale: 1.8 }] });
    expect([...r.illustrated]).toEqual([
      [2, 'Lima enam'],
      [3, 'Tujuh'],
    ]);
    expect(r.notes[0]).toEqual({
      beat: 2,
      what: 'vox/kinetic-serif planned 6 times: this one is vox/paper-collage with a picture of "Lima enam" (at most 2 of a template)',
    });
    expect(r.counts.get('vox/paper-collage')).toBe(MAX_SAME_TEMPLATE);
    // no image model: text-led as before, nothing illustrated
    const plain = varySceneTemplates(beats, textLed, templates);
    expect(plain.illustrated.size).toBe(0);
    expect(plain.beats.map((b) => b.template)).not.toContain('vox/paper-collage');
  });

  test('picture-led: over-used collages never turn into more collages; none in a text style', () => {
    const pic = pictureLedTemplate(IDS, templates)!;
    const beats = [collage(0, 'A b'), collage(3000, 'C d'), collage(6000, 'E f')];
    const r = varySceneTemplates(beats, textLed, templates, pic);
    expect(r.beats[2]!.template).toBe('vox/kinetic-serif');
    expect(r.illustrated.size).toBe(0);
    expect(pictureLedTemplate(['vox/kinetic-serif', 'base/title'], templates)).toBeUndefined();
  });

  // D-106, demo run 7: pictures only came when the model over-used a template; with an image
  // model a varied text-only plan still gets MIN_PICTURE_LED pictures, never on the hook scene
  test('picture-led minimum (D-106): the longest text cards after the hook turn into pictures', () => {
    const pic = pictureLedTemplate(IDS, templates)!;
    const beat = (startMs: number, template: string, variables: Record<string, unknown>) =>
      ({ startMs, endMs: startMs + 4000, kind: 'scene', template, variables }) as VaryBeat;
    const beats = [
      beat(0, 'vox/kinetic-serif', { text: 'Hook yang paling panjang sekali' }),
      beat(4000, 'vox/newspaper', { headline: 'Rezeki' }),
      beat(8000, 'vox/kinetic-serif', { text: 'Pintu yang lebih besar' }),
      beat(12000, 'vox/newspaper', { headline: 'Dijauhkan dari pengeluaran' }),
    ];
    const r = varySceneTemplates(beats, textLed, templates, pic);
    expect(r.beats.map((b) => b.template)).toEqual([
      'vox/kinetic-serif',
      'vox/newspaper',
      'vox/paper-collage',
      'vox/paper-collage',
    ]);
    expect([...r.illustrated].sort()).toEqual([
      [2, 'Pintu yang lebih besar'],
      [3, 'Dijauhkan dari pengeluaran'],
    ]);
    expect(r.notes.map((n) => n.beat).sort()).toEqual([2, 3]);
    expect(r.notes.find((n) => n.beat === 3)!.what).toBe(
      'vox/newspaper "Dijauhkan dari pengeluaran": vox/paper-collage with a picture of it instead (at least 2 pictures with an image model)',
    );
    expect(r.counts.get('vox/paper-collage')).toBe(MIN_PICTURE_LED);
    // a beat shorter than the collage's minimum goes last
    const short = beats.map((b, i) => (i === 3 ? { ...b, endMs: b.startMs + 500 } : b));
    const s = varySceneTemplates(short, textLed, templates, pic);
    expect([...s.illustrated.keys()].sort()).toEqual([1, 2]);
    // no image model: the plan is kept
    expect(varySceneTemplates(beats, textLed, templates).beats).toEqual(beats);
  });

  test('the drawn picture moves above captions burned in mid-frame (D-107)', () => {
    const pic = pictureLedTemplate(IDS, templates)!;
    const one = { items: [{ media: 'm1', x: 50, y: 42, scale: 1.8 }] };
    const notes: string[] = [];
    const moved = pictureAboveCaptions(pic, one, 50, (w) => notes.push(w));
    expect(moved).toEqual({ items: [{ media: 'm1', x: 50, y: 25, scale: 1.5 }] });
    expect(notes).toEqual(['picture moved up to 25 % (clear of the captions at 50 %)']);
    // captions low or high, none, or several entries: unchanged
    for (const y of [80, 20, undefined])
      expect(pictureAboveCaptions(pic, one, y, () => {})).toBe(one);
    const two = { items: [...one.items, { media: 'm2', x: 20, y: 70 }] };
    expect(pictureAboveCaptions(pic, two, 50, () => {})).toBe(two);
  });

  test('picture-led planned empty (D-103): one centred entry drawn from its label', () => {
    const pic = pictureLedTemplate(IDS, templates)!;
    const empty: VaryBeat = {
      startMs: 0,
      endMs: 2000,
      kind: 'scene',
      template: 'vox/paper-collage',
      variables: { items: [], label: 'Pintu rezeki' },
    };
    const none: VaryBeat = { ...empty, startMs: 3000, endMs: 5000, variables: { items: [] } };
    const r = varySceneTemplates([empty, none], textLed, templates, pic);
    expect(r.beats[0]!.variables).toEqual({
      items: [{ media: '', x: 50, y: 42, scale: 1.8 }],
      label: 'Pintu rezeki',
    });
    // no text to draw: left for the usual repairs; a planned entry: untouched (below)
    expect(r.beats[1]).toEqual(none);
    const full = collage(6000, 'Full');
    expect(varySceneTemplates([full], textLed, templates, pic).beats).toEqual([full]);
    expect([...r.illustrated]).toEqual([[0, 'Pintu rezeki']]);
    expect(r.notes).toEqual([
      { beat: 0, what: 'vox/paper-collage planned with no items: one picture of "Pintu rezeki"' },
    ]);
    // no image model: nothing changes
    expect(varySceneTemplates([empty], textLed, templates).beats).toEqual([empty]);
  });
});

describe('text clear of the captions (D-96)', () => {
  const overlay = () => get('base/text-overlay');
  const run = (vars: Record<string, unknown>, y: number | undefined) => {
    const notes: string[] = [];
    return { out: clearOfCaptions(overlay(), vars, y, (w) => notes.push(w)), notes };
  };

  test('the run 3 overlay (default bottom) over two-tier captions at 50 % moves to the top', () => {
    const { out, notes } = run({ text: 'Peluang tak terduga' }, 50);
    expect(out).toEqual({ text: 'Peluang tak terduga', position: 'top' });
    expect(notes).toEqual(['position bottom → top (clear of the captions at 50 %)']);
  });

  test('a position already clear of the captions is kept', () => {
    expect(run({ text: 'x', position: 'bottom' }, 80).out).toEqual({
      text: 'x',
      position: 'bottom',
    });
    expect(run({ text: 'x', position: 'top' }, 50).notes).toEqual([]);
  });

  test('middle over captions at 50 % moves; without captions nothing changes', () => {
    expect(run({ text: 'x', position: 'middle' }, 50).out['position']).toBe('top');
    expect(run({ text: 'x', position: 'middle' }, undefined).out).toEqual({
      text: 'x',
      position: 'middle',
    });
  });

  test('a template with no position choice is unchanged', () => {
    const notes: string[] = [];
    const vars = { text: 'Rezeki' };
    expect(clearOfCaptions(get('vox/kinetic-serif'), vars, 50, (w) => notes.push(w))).toBe(vars);
    expect(notes).toEqual([]);
  });
});
