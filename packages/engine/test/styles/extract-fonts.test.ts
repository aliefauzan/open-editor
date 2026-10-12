// Phase 15 GATE 8 round 3: measured caption fonts (samplers, the tool result in the measurements'
// form), the two-tier caption preset written from the engine template, the draft that uses the
// measured fonts, and the caption beats of the behind-the-subject render step.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { captionBeats } from '../../src/export-api.ts';
import {
  BEHIND_MIN_FRAMES,
  twoTierHtml,
  twoTierLook,
  twoTierTrack,
} from '../../src/styles/extract/caption-preset.ts';
import { familyFiles, loadFontCatalogue } from '../../src/styles/extract/catalogue.ts';
import {
  captionFonts,
  fontCandidates,
  fontSamples,
  occlusionSamples,
  trackingReveals,
  type CaptionFonts,
  type FontMatchResult,
  type OcrFrame,
} from '../../src/styles/extract/fontmatch.ts';
import { mapDraftStyle } from '../../src/styles/extract/map.ts';
import { MeasurementsSchema } from '../../src/styles/extract/measure.ts';
import { writeDraftStyle } from '../../src/styles/extract/write.ts';
import { CaptionPresetSchema } from '../../src/styles/schema.ts';
import { FONTS, mapInput, measurements, userStyles } from './extract-fixture.ts';

const box = (x: number, y: number, w = 0.3, h = 0.04) => ({ x, y, w, h });
const line = (text: string, b = box(0.35, 0.45)) => ({ text, box: b });

describe('font samples from OCR frames', () => {
  test('stable centred plain-word lines, one frame per text, upper-case frames first', () => {
    const frames: OcrFrame[] = [
      { atMs: 0, lines: [line('a literal')] },
      { atMs: 250, lines: [line('a literal'), line('SUGAR FIELD', box(0.3, 0.5))] },
      { atMs: 500, lines: [line('a literal'), line('SUGAR FIELD', box(0.3, 0.5))] },
      // moving: not stable
      { atMs: 750, lines: [line('moving on', box(0.1, 0.45))] },
      { atMs: 1000, lines: [line('moving on', box(0.2, 0.45))] },
      // numbers and off-centre lines are left out
      { atMs: 1250, lines: [line('2 billion')] },
      { atMs: 1500, lines: [line('2 billion')] },
      { atMs: 1750, lines: [line('side note', box(0.0, 0.1, 0.2))] },
      { atMs: 2000, lines: [line('side note', box(0.0, 0.1, 0.2))] },
    ];
    const s = fontSamples(frames);
    expect(s.map((x) => x.atMs)).toEqual([250]);
    expect(s[0]!.lines.map((l) => l.text)).toEqual(['a literal', 'SUGAR FIELD']);
    expect(fontSamples(frames)).toEqual(s);
  });

  test('occlusion frames: centred lines only, at most 60, evenly spread', () => {
    const frames: OcrFrame[] = Array.from({ length: 300 }, (_, i) => ({
      atMs: i * 250,
      lines: i % 2 ? [line('x y z')] : [line('edge', box(0, 0.1, 0.1))],
    }));
    const o = occlusionSamples(frames);
    expect(o).toHaveLength(60);
    expect(o.every((f) => f.atMs % 500 === 250 && f.boxes.length === 1)).toBe(true);
  });

  test('a single word whose box widens at the same height is a tracking reveal', () => {
    const frames: OcrFrame[] = [
      { atMs: 0, lines: [line('Bunny', box(0.4, 0.47, 0.3, 0.1))] },
      { atMs: 250, lines: [line('Bunny', box(0.35, 0.47, 0.4, 0.1))] },
      { atMs: 2000, lines: [line('steady', box(0.4, 0.47, 0.3, 0.1))] },
      { atMs: 2250, lines: [line('steady', box(0.4, 0.47, 0.3, 0.1))] },
    ];
    expect(trackingReveals(frames)).toEqual({ events: 1, of: 2 });
  });

  test('every catalogue file is a candidate; variable files at 400 and 700 inside their range', () => {
    const cat = loadFontCatalogue(FONTS);
    const c = fontCandidates(cat);
    expect(c).toHaveLength(cat.fonts.length);
    expect(c.every((x) => existsSync(x.path))).toBe(true);
    const crimson = c.find((x) => x.id === 'CrimsonPro-Italic-Variable.ttf')!;
    expect(crimson.weights).toEqual([400, 700]);
    expect(c.find((x) => x.id === 'VT323-Regular.ttf')!.weights).toEqual([]);
  });
});

function toolResult(): FontMatchResult {
  const r = (font: string, score: number, eligible = true) => ({
    font,
    weight: null,
    score,
    iou: score,
    trackingEm: -0.045,
    stretch: font.startsWith('DotGothic') ? 1.3 : 1,
    advanceEm: font.startsWith('DotGothic') ? 0.65 : 0.34,
    axisNative: 0.5,
    sizePct: font.startsWith('DotGothic') ? 4 : 4.65,
    eligible,
  });
  const tierLook = {
    refAxis: 0.2,
    yPct: 48,
    textLightShare: 1,
    fringePx: 0.05,
    fringeSplit: 14,
    fringeShare: 0.5,
    glowShare: 0.3,
  };
  return {
    width: 720,
    height: 1280,
    occlusion: { available: true, frames: 60, decided: 5, behind: 3, atMs: [29000, 33750, 53500] },
    frames: 20,
    candidates: 90,
    lines: [],
    tiers: [
      {
        tier: 1,
        lines: 11,
        ranking: [r('InstrumentSerif-Italic.ttf', 0.661), r('InstrumentSerif-Regular.ttf', 0.54)],
        pick: r('InstrumentSerif-Italic.ttf', 0.661),
        boxedShare: 0,
        box: null,
        ...tierLook,
      },
      {
        tier: 2,
        lines: 7,
        ranking: [
          r('JetBrainsMono-Variable.ttf', 0.815, false),
          r('DotGothic16-Regular.ttf', 0.675),
        ],
        pick: r('DotGothic16-Regular.ttf', 0.675),
        boxedShare: 0.6,
        box: {
          fill: '#FDFBFA',
          fillLightness: 0.985,
          padXEm: 0.04,
          padYEm: 0.1,
          outlineShare: 0.33,
          ruleShare: 0,
          knockoutShare: 1,
        },
        ...tierLook,
      },
    ],
    twoTier: { frames: 4, share: 0.2 },
  };
}

function fonts(): CaptionFonts {
  return captionFonts(toolResult(), loadFontCatalogue(FONTS), { events: 1, of: 6 })!;
}

describe('caption fonts in the measurements', () => {
  test('catalogue families, italic flags and runners-up; the measurements accept them', () => {
    const f = fonts();
    expect(f.tiers.map((t) => [t.tier, t.pick.family, t.pick.italic])).toEqual([
      [1, 'Instrument Serif', true],
      [2, 'DotGothic16', false],
    ]);
    expect(f.tiers[1]!.runnersUp[0]).toMatchObject({ family: 'JetBrains Mono', eligible: false });
    expect(f.tiers[0]!.pick.weight).toBe(400);
    MeasurementsSchema.parse({ ...measurements(), fonts: f });
  });

  test('no tier with a known pick gives null', () => {
    const r = toolResult();
    r.tiers = r.tiers.map((t) => ({ ...t, pick: { ...t.pick!, font: 'Nope.ttf' } }));
    expect(captionFonts(r, loadFontCatalogue(FONTS), { events: 0, of: 0 })).toBeNull();
  });
});

describe('two-tier caption preset', () => {
  test('the look follows the measured tiers; the template gets numbers and one colour only', () => {
    const look = twoTierLook(fonts());
    expect(look).toMatchObject({
      t1: { size: 0.0465, italic: true },
      t2: { size: 0.04, stretch: 1.3 },
      box: { fill: '#FDFBFA', knockout: true, rule: true },
      fringe: 1.5,
      t1Fringe: true,
      glow: true,
      reveal: true,
      behindSubject: true,
    });
    const html = twoTierHtml(look);
    expect(html).not.toMatch(/@@/);
    expect(html).toContain("fill: '#FDFBFA'");
    expect(html).toContain('font-style: italic');
    expect(() => twoTierHtml(look, 'x @@NOPE@@')).toThrow(/NOPE/);
  });

  test('without Vision or with too few frames, the captions stay in front', () => {
    const f = fonts();
    expect(
      twoTierLook({ ...f, occlusion: { ...f.occlusion, available: false } }).behindSubject,
    ).toBe(false);
    expect(
      twoTierLook({ ...f, occlusion: { ...f.occlusion, behind: BEHIND_MIN_FRAMES - 1 } })
        .behindSubject,
    ).toBe(false);
  });
});

describe('map with measured fonts', () => {
  test('tier 1 sets body and display, tier 2 the caption font; the preset is the two-tier one', () => {
    const s = userStyles();
    const input = mapInput(s.reg(), { measurements: { ...measurements(), fonts: fonts() } });
    const d = mapDraftStyle(input);
    const f = d.styleFile.tokens!.fonts!;
    expect(f.body).toEqual({
      family: 'Instrument Serif',
      file: 'assets/fonts/InstrumentSerif-Regular.ttf',
      weight: 400,
    });
    expect(f.display?.family).toBe('Instrument Serif');
    expect(f.caption).toMatchObject({ family: 'DotGothic16', weight: 400 });
    // the italic file is copied with its family, with the licence
    const to = d.files.map((x) => x.to);
    expect(to).toContain('assets/fonts/InstrumentSerif-Italic.ttf');
    expect(to).toContain('assets/fonts/OFL-instrumentserif.txt');
    expect(to).toContain('assets/fonts/OFL-dotgothic16.txt');
    expect(to).not.toContain('captions/reference.html');
    const cat = loadFontCatalogue(FONTS);
    expect(
      familyFiles(cat, 'Instrument Serif').every((e) => to.includes(`assets/fonts/${e.file}`)),
    ).toBe(true);
    // the preset: generated HTML, behind the subject, schema-valid
    const p = d.captionPreset!;
    expect(p.basedOn).toBe('measured two-tier');
    expect(p.html).toBeDefined();
    expect(CaptionPresetSchema.parse(p.json)).toMatchObject({
      name: 'reference',
      behindSubject: true,
      // two tiers: key words boxed on their own line, chunk size from the events (D-93)
      tiered: true,
      track: { maxLines: 2, autoEmphasis: true },
    });
    expect(d.drivers.find((x) => x.token === 'fonts.body')?.from).toMatch(
      /measured: tier 1.*0\.661/,
    );
    expect(d.drivers.find((x) => x.token === 'captions.behindSubject')?.value).toBe('true');
    // deterministic, and the draft folder gets the HTML
    expect(JSON.stringify(mapDraftStyle(input))).toBe(JSON.stringify(d));
    const { dir } = writeDraftStyle(s.dirs, d);
    expect(readFileSync(join(dir, 'captions', 'reference.html'), 'utf8')).toBe(p.html);
    expect(s.reg().get('ref-look').captionPresets['ref-look/reference']?.behindSubject).toBe(true);
  });

  test('the track of a two-tier preset: tier 1 words and characters a line (90th percentile)', () => {
    const ev = (text: string) => ({ text });
    const events = [
      ev('at first'),
      ev('this looked like a'),
      ev('He wanted you to step INTO HIS HOME'),
      ev('performing on the BIGGEST STAGE'),
      ev('REAL VOWS'),
      ev("Because he didn't want you"),
      ev('that people see themselves'),
      ev('on the turf'),
      ev('Then he passes his GRAMMY'),
      ev('a real couple gets MARRIED'),
    ];
    // nine events with tier 1 words: 2, 4, 5, 3, 5, 4, 3, 4, 4 words; 8 to 26 characters
    expect(twoTierTrack(events)).toEqual({
      maxWords: 5,
      maxLines: 2,
      maxCharsPerLine: 26,
      autoEmphasis: true,
    });
    // nothing to measure: the reference's usual line; clamped to 2-8 words, 12-40 characters
    expect(twoTierTrack([ev('ONLY CAPS')])).toMatchObject({ maxWords: 5, maxCharsPerLine: 26 });
    expect(twoTierTrack([ev('a b c d e f g h i j k l')])).toMatchObject({ maxWords: 8 });
    expect(twoTierTrack([ev('hi')])).toMatchObject({ maxWords: 2, maxCharsPerLine: 12 });
  });

  test('without measured fonts the preset is still copied from the parent', () => {
    const s = userStyles();
    const d = mapDraftStyle(mapInput(s.reg()));
    expect(d.captionPreset?.html).toBeUndefined();
    expect(d.files.map((x) => x.to)).toContain('captions/reference.html');
  });
});

describe('caption beats of the behind-the-subject step', () => {
  test('chunk times in render time, cut to the range', () => {
    const chunks = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1500, endMs: 2600 },
      { startMs: 5000, endMs: 6000 },
    ];
    expect(captionBeats(chunks)).toEqual(chunks);
    expect(captionBeats(chunks, { startMs: 1000, endMs: 2000 })).toEqual([
      { startMs: 500, endMs: 1000 },
    ]);
  });
});
