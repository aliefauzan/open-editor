// Deterministic ClipPlan repairs (D-94): variables fitted to their template (the D-90 open item) and
// scene variety (owner report "that vid still not perfect": four paper-collage scenes in a row).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapTemplateLookup, type TemplateInfo } from '@vox/engine';
import { describe, expect, test } from 'vitest';
import {
  MAX_SAME_TEMPLATE,
  fitVariables,
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
});
