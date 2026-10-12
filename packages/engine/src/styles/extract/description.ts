// Styles Part C step 3, "Describe": the structured JSON a vision model returns for a reference video
// (styles spec "Part C"; plan phase 15). The agent package asks for it (`vision` role) and the map
// step reads it. Everything in it is untrusted model output: it only picks among fixed options,
// bounded numbers and short texts, and its texts are escaped wherever they are shown.
import { z } from 'zod';
import { FONT_CLASSES } from './catalogue.ts';

const text = (max: number) => z.string().max(max);
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const FontDescription = z.strictObject({
  classification: z.enum(FONT_CLASSES),
  /** CSS weight. */
  weight: z.int().min(100).max(1000),
  case: z.enum(['upper', 'lower', 'asis']),
  /** Free tags matched against the catalogue tags, e.g. condensed, didone, geometric, typewriter. */
  tags: z.array(text(40)).max(8),
});

export const StyleDescriptionSchema = z.strictObject({
  /** One paragraph on the look, for the guide. */
  summary: text(800),
  fonts: z.strictObject({
    display: FontDescription,
    body: FontDescription,
    caption: FontDescription,
  }),
  captions: z.strictObject({
    /** Words sit on a filled box or plate. */
    boxed: z.boolean(),
    textColor: hexColor.nullable(),
    boxColor: hexColor.nullable(),
    /** Words appear one at a time. */
    wordByWord: z.boolean(),
    emphasis: text(200),
  }),
  motion: z.strictObject({
    /** 1 = smooth, 2–3 = held frames (stop-motion feel). */
    frameHold: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    entrance: z.enum(['pop', 'fade', 'slide', 'none']),
    cameraMoves: z.array(text(60)).max(8),
    notes: text(400),
  }),
  texture: z.strictObject({
    paper: z.boolean(),
    grain: z.number().min(0).max(1),
    film: z.boolean(),
  }),
  layouts: z
    .array(
      z.strictObject({
        name: text(80),
        description: text(300),
        /** A template id the layout resembles (`<style>/<template>`), or null. */
        closestTemplate: text(100).nullable(),
      }),
    )
    .max(12),
  /** Image search hints (archive queries). */
  imagery: z.array(text(80)).max(8),
});
export type StyleDescription = z.infer<typeof StyleDescriptionSchema>;

// ---- near-miss repair (small local vision models) ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strs = (v: unknown, n: number, max: number): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .filter((x): x is string => typeof x === 'string')
    .slice(0, n)
    .map((x) => x.slice(0, max));
const bool = (v: unknown): unknown => (v === 'true' ? true : v === 'false' ? false : v);
const num = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const WEIGHT_WORDS: Record<string, number> = {
  thin: 100,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
  heavy: 900,
};
const CLASS_WORDS: Record<string, (typeof FONT_CLASSES)[number]> = {
  'sans-serif': 'sans',
  sansserif: 'sans',
  grotesk: 'sans',
  grotesque: 'sans',
  geometric: 'sans',
  humanist: 'sans',
  didone: 'serif',
  italic: 'serif',
  'slab-serif': 'slab',
  slabserif: 'slab',
  monospace: 'mono',
  monospaced: 'mono',
  typewriter: 'mono',
  handwritten: 'script',
  handwriting: 'script',
  cursive: 'script',
};
const ENTRANCE_WORDS: Record<string, 'pop' | 'fade' | 'slide' | 'none'> = {
  cut: 'none',
  'fade in': 'fade',
  'fade-in': 'fade',
  dissolve: 'fade',
  zoom: 'pop',
  scale: 'pop',
  bounce: 'pop',
  wipe: 'slide',
  push: 'slide',
};

function repairFont(v: unknown): unknown {
  if (!isObj(v)) return v;
  const cls = str(v['classification'], 40).toLowerCase().trim();
  const w = num(v['weight']);
  const weight =
    typeof w === 'number'
      ? clamp(Math.round(w), 100, 1000)
      : (WEIGHT_WORDS[str(w, 20).toLowerCase().replace(/[\s-]/g, '')] ?? 400);
  const c = str(v['case'], 40).toLowerCase();
  return {
    classification: (FONT_CLASSES as readonly string[]).includes(cls)
      ? cls
      : (CLASS_WORDS[cls] ?? (cls.includes('serif') && !cls.includes('sans') ? 'serif' : 'sans')),
    weight,
    case: /^(upper|uppercase|all ?caps|caps)$/.test(c)
      ? 'upper'
      : /^(lower|lowercase)$/.test(c)
        ? 'lower'
        : 'asis',
    tags: strs(v['tags'], 8, 40),
  };
}

function repairHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s;
  const m = /^#?([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])$/.exec(s);
  if (m) return `#${m[1]!}${m[1]!}${m[2]!}${m[2]!}${m[3]!}${m[3]!}`;
  return /^[0-9A-Fa-f]{6}$/.test(s) ? `#${s}` : null;
}

/**
 * Fixes the near misses a small vision model makes before `StyleDescriptionSchema` parses the
 * answer: case and class words outside the options ("mixed" → `asis`, "sans-serif" → `sans`), weight
 * words, numbers sent as strings, numbers out of range, too long texts and lists, short hex colours,
 * and unknown keys (dropped). Values it cannot read become the neutral option; the parse still
 * rejects an answer whose shape is wrong (a missing section).
 */
export function repairDescription(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const fonts = isObj(raw['fonts']) ? raw['fonts'] : {};
  const cap = isObj(raw['captions']) ? raw['captions'] : undefined;
  const mo = isObj(raw['motion']) ? raw['motion'] : undefined;
  const tx = isObj(raw['texture']) ? raw['texture'] : undefined;
  const hold = num(mo?.['frameHold']);
  const ent = str(mo?.['entrance'], 40).toLowerCase().trim();
  const grain = num(tx?.['grain']);
  return {
    summary: str(raw['summary'], 800),
    fonts: {
      display: repairFont(fonts['display']),
      body: repairFont(fonts['body']),
      caption: repairFont(fonts['caption']),
    },
    captions: cap && {
      boxed: bool(cap['boxed']),
      textColor: repairHex(cap['textColor']),
      boxColor: repairHex(cap['boxColor']),
      wordByWord: bool(cap['wordByWord']),
      emphasis: str(cap['emphasis'], 200),
    },
    motion: mo && {
      frameHold: typeof hold === 'number' ? clamp(Math.round(hold), 1, 3) : 1,
      entrance: ['pop', 'fade', 'slide', 'none'].includes(ent)
        ? ent
        : (ENTRANCE_WORDS[ent] ?? 'none'),
      cameraMoves: strs(mo['cameraMoves'], 8, 60),
      notes: str(mo['notes'], 400),
    },
    texture: tx && {
      paper: bool(tx['paper']),
      grain:
        typeof grain === 'number'
          ? clamp(grain > 1 && grain <= 100 ? grain / 100 : grain, 0, 1)
          : 0,
      film: bool(tx['film']),
    },
    layouts: (Array.isArray(raw['layouts']) ? raw['layouts'] : [])
      .filter(isObj)
      .slice(0, 12)
      .map((l) => ({
        name: str(l['name'], 80),
        description: str(l['description'], 300),
        closestTemplate:
          typeof l['closestTemplate'] === 'string' && l['closestTemplate'] !== ''
            ? l['closestTemplate'].slice(0, 100)
            : null,
      })),
    imagery: strs(raw['imagery'], 8, 80),
  };
}
