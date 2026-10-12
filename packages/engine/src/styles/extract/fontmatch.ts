// Measured caption fonts and caption look (styles Part C, plan phase 15 GATE 8 round 3). The OCR
// frames give the caption lines; `vox_py.fontmatch` crops each line, renders the same text in every
// catalogue font and keeps the best match per caption tier (tier 1: mixed case, tier 2: upper case),
// with the tier's box, fringe and glow. It also checks a set of frames for captions that run behind
// the foreground subject (Apple Vision subject mask). The samplers here are pure and deterministic.
import { join } from 'node:path';
import { z } from 'zod';
import type { FontCatalogue } from './catalogue.ts';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrFrame {
  atMs: number;
  lines: { text: string; box: Box }[];
}

export interface FontSample {
  atMs: number;
  lines: { text: string; box: Box }[];
}

// ---- tool result (py/tests/schemas/fontmatch.result.json) ----

const Score = z.strictObject({
  font: z.string(),
  weight: z.int().nullable(),
  score: z.number(),
  iou: z.number(),
  trackingEm: z.number(),
  stretch: z.number(),
});

const Ranked = z.strictObject({
  font: z.string(),
  weight: z.int().nullable(),
  score: z.number(),
  iou: z.number(),
  trackingEm: z.number(),
  stretch: z.number(),
  advanceEm: z.number(),
  axisNative: z.number(),
  sizePct: z.number(),
  eligible: z.boolean(),
});

const TierBox = z.strictObject({
  fill: z
    .string()
    .regex(/^#[0-9A-F]{6}$/)
    .nullable(),
  fillLightness: z.number(),
  padXEm: z.number(),
  padYEm: z.number(),
  outlineShare: z.number(),
  ruleShare: z.number(),
  knockoutShare: z.number(),
});

const Tier = z.strictObject({
  tier: z.union([z.literal(1), z.literal(2)]),
  lines: z.int().min(1),
  ranking: z.array(Ranked),
  pick: Ranked.nullable(),
  refAxis: z.number(),
  yPct: z.number(),
  boxedShare: z.number(),
  box: TierBox.nullable(),
  textLightShare: z.number(),
  fringePx: z.number(),
  fringeSplit: z.number(),
  fringeShare: z.number(),
  glowShare: z.number(),
});

export const FontMatchResultSchema = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
  occlusion: z.strictObject({
    available: z.boolean(),
    frames: z.int().nonnegative(),
    decided: z.int().nonnegative(),
    behind: z.int().nonnegative(),
    atMs: z.array(z.int().nonnegative()),
  }),
  frames: z.int().nonnegative(),
  candidates: z.int().nonnegative(),
  lines: z.array(
    z.strictObject({
      text: z.string(),
      case: z.enum(['asis', 'upper', 'lower']),
      tier: z.union([z.literal(1), z.literal(2)]),
      yPct: z.number(),
      sizePct: z.number(),
      separation: z.number(),
      axisNative: z.number(),
      look: z.strictObject({
        textLight: z.boolean(),
        boxed: z.boolean(),
        box: z
          .strictObject({
            fill: z.string(),
            fillLightness: z.number(),
            padXEm: z.number(),
            padYEm: z.number(),
            outline: z.boolean(),
            rule: z.boolean(),
            knockout: z.boolean(),
          })
          .nullable(),
        fringePx: z.number(),
        fringeSplit: z.number(),
        glow: z.boolean(),
      }),
      atMs: z.int().nonnegative(),
      best: z.array(Score),
    }),
  ),
  tiers: z.array(Tier),
  twoTier: z.strictObject({ frames: z.int().nonnegative(), share: z.number() }),
});
export type FontMatchResult = z.infer<typeof FontMatchResultSchema>;

// ---- what the measurements keep ----

const FontPick = z.strictObject({
  /** Catalogue file and family; `italic` when the matched file is an italic face. */
  file: z.string(),
  family: z.string(),
  italic: z.boolean(),
  weight: z.int().min(1).max(1000),
  score: z.number(),
  trackingEm: z.number(),
  stretch: z.number(),
  advanceEm: z.number(),
  /** Font size as a share of the frame height (%). */
  sizePct: z.number(),
});
export type FontPick = z.infer<typeof FontPick>;

export const CaptionFontsSchema = z.strictObject({
  tiers: z.array(
    z.strictObject({
      tier: z.union([z.literal(1), z.literal(2)]),
      lines: z.int().min(1),
      pick: FontPick,
      /** The best few faces with their mean score (the report shows them). */
      runnersUp: z.array(
        z.strictObject({
          family: z.string(),
          italic: z.boolean(),
          weight: z.int(),
          score: z.number(),
          eligible: z.boolean(),
        }),
      ),
      yPct: z.number(),
      boxedShare: z.number().min(0).max(1),
      box: TierBox.nullable(),
      textLightShare: z.number().min(0).max(1),
      fringePx: z.number().min(0),
      /** Red/cyan split at the text edges (0..255, median over the tier's lines). */
      fringeSplit: z.number().min(0),
      fringeShare: z.number().min(0).max(1),
      glowShare: z.number().min(0).max(1),
    }),
  ),
  /** Share of the sampled frames with a tier 1 line right above a tier 2 line. */
  twoTierShare: z.number().min(0).max(1),
  /** Captions behind the foreground subject (Apple Vision; `available: false` elsewhere). */
  occlusion: z.strictObject({
    available: z.boolean(),
    frames: z.int().nonnegative(),
    decided: z.int().nonnegative(),
    behind: z.int().nonnegative(),
    atMs: z.array(z.int().nonnegative()),
  }),
  /** Single-word captions whose letter spacing changes between OCR frames (a tracking reveal). */
  trackingReveal: z.strictObject({ events: z.int().nonnegative(), of: z.int().nonnegative() }),
});
export type CaptionFonts = z.infer<typeof CaptionFontsSchema>;

// ---- samplers ----

const USABLE = /^[A-Za-z'’.,!?-]+( [A-Za-z'’.,!?-]+)*$/;
const MAX_SAMPLES = 20;
const MAX_LINES = 40;
export const MAX_OCCLUSION_FRAMES = 60;

const centred = (b: Box) => b.x + b.w / 2 >= 0.2 && b.x + b.w / 2 <= 0.8;
const letters = (t: string) => [...t].filter((c) => /[A-Za-z]/.test(c)).length;
const isUpper = (t: string) => t.toUpperCase() === t && t.toLowerCase() !== t;

function sameLine(a: { text: string; box: Box }, b: { text: string; box: Box }): boolean {
  return (
    a.text === b.text &&
    (['x', 'y', 'w', 'h'] as const).every((k) => Math.abs(a.box[k] - b.box[k]) <= 0.01)
  );
}

function spread<T>(a: readonly T[], n: number): T[] {
  if (a.length <= n) return [...a];
  return Array.from({ length: n }, (_, i) => a[Math.floor((i * a.length) / n)]!);
}

/**
 * Frames whose centred caption lines are all plain words (letters and a little punctuation, three
 * letters or more) and stable: each line is in the previous or the next OCR frame with the same text
 * and box (±1 %), so the decoded frame is not mid-cut or mid-animation. One frame per distinct text;
 * up to 12 frames with an upper-case line and 8 without, in time order, at most 40 lines.
 */
export function fontSamples(frames: readonly OcrFrame[]): FontSample[] {
  const stable: FontSample[] = [];
  for (let i = 1; i < frames.length - 1; i++) {
    const ls = frames[i]!.lines.filter((l) => centred(l.box));
    if (ls.length === 0) continue;
    if (!ls.every((l) => USABLE.test(l.text.trim()) && letters(l.text) >= 3)) continue;
    const near = [...frames[i - 1]!.lines, ...frames[i + 1]!.lines];
    if (!ls.every((l) => near.some((m) => sameLine(l, m)))) continue;
    stable.push({ atMs: frames[i]!.atMs, lines: ls.map((l) => ({ text: l.text, box: l.box })) });
  }
  const seen = new Set<string>();
  const uniq = stable.filter((s) => {
    const key = s.lines.map((l) => l.text).join('\n');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const up = uniq.filter((s) => s.lines.some((l) => isUpper(l.text)));
  const mixed = uniq.filter((s) => !up.includes(s));
  const picked = [...spread(up, 12), ...spread(mixed, MAX_SAMPLES - 12)].sort(
    (a, b) => a.atMs - b.atMs,
  );
  const out: FontSample[] = [];
  let lines = 0;
  for (const s of picked) {
    if (lines + s.lines.length > MAX_LINES) continue;
    lines += s.lines.length;
    out.push(s);
  }
  return out;
}

/** OCR frames with centred caption lines, evenly spread, at most 60, with their boxes (≤ 4). */
export function occlusionSamples(frames: readonly OcrFrame[]): { atMs: number; boxes: Box[] }[] {
  const withLines = frames
    .map((f) => ({ atMs: f.atMs, boxes: f.lines.filter((l) => centred(l.box)).map((l) => l.box) }))
    .filter((f) => f.boxes.length > 0)
    .map((f) => ({ atMs: f.atMs, boxes: f.boxes.slice(0, 4) }));
  return spread(withLines, MAX_OCCLUSION_FRAMES);
}

/**
 * Single-word captions (one centred line of one word, 3+ letters) seen in consecutive OCR frames
 * with the same height (±10 %) but a width that changes by 10 % or more: letters spreading or
 * tightening. `of`: the single-word captions seen in two consecutive frames at all.
 */
export function trackingReveals(frames: readonly OcrFrame[]): { events: number; of: number } {
  const counted = new Set<string>();
  const seen = new Set<string>();
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!.lines.filter((l) => centred(l.box));
    const b = frames[i]!.lines.filter((l) => centred(l.box));
    for (const l of b) {
      const text = l.text.trim();
      if (text.includes(' ') || letters(text) < 3) continue;
      const prev = a.find((m) => m.text.trim() === text);
      if (!prev) continue;
      const key = `${text}@${String(Math.round(frames[i]!.atMs / 2000))}`;
      seen.add(key);
      const dh = Math.abs(l.box.h - prev.box.h) / Math.max(1e-6, prev.box.h);
      const dw = Math.abs(l.box.w - prev.box.w) / Math.max(1e-6, prev.box.w);
      if (dh <= 0.1 && dw >= 0.1) counted.add(key);
    }
  }
  return { events: counted.size, of: seen.size };
}

/** Every catalogue file as a candidate; a variable file at 400 and 700 (inside its range). */
export function fontCandidates(
  cat: FontCatalogue,
): { id: string; path: string; weights: number[] }[] {
  return cat.fonts.map((f) => {
    const { min, max } = f.weights;
    const weights =
      min === max ? [] : [...new Set([400, 700].map((w) => Math.min(max, Math.max(min, w))))];
    return { id: f.file, path: join(cat.dir, f.file), weights };
  });
}

/** The tool result in the measurements' form (catalogue family names; at most 5 runners-up). */
export function captionFonts(
  r: FontMatchResult,
  cat: FontCatalogue,
  reveal: { events: number; of: number },
): CaptionFonts | null {
  const entry = (file: string) => cat.fonts.find((f) => f.file === file);
  const tiers: CaptionFonts['tiers'] = [];
  for (const t of r.tiers) {
    const p = t.pick;
    const e = p && entry(p.font);
    if (!p || !e) continue;
    tiers.push({
      tier: t.tier,
      lines: t.lines,
      pick: {
        file: e.file,
        family: e.family,
        italic: e.italic ?? false,
        weight: p.weight ?? e.weights.min,
        score: p.score,
        trackingEm: p.trackingEm,
        stretch: p.stretch,
        advanceEm: p.advanceEm,
        sizePct: p.sizePct,
      },
      runnersUp: t.ranking
        .filter((x) => x !== p && !(x.font === p.font && x.weight === p.weight))
        .slice(0, 5)
        .flatMap((x) => {
          const f = entry(x.font);
          return f
            ? [
                {
                  family: f.family,
                  italic: f.italic ?? false,
                  weight: x.weight ?? f.weights.min,
                  score: x.score,
                  eligible: x.eligible,
                },
              ]
            : [];
        }),
      yPct: t.yPct,
      boxedShare: t.boxedShare,
      box: t.box,
      textLightShare: t.textLightShare,
      fringePx: Math.max(0, t.fringePx),
      fringeSplit: Math.max(0, t.fringeSplit),
      fringeShare: t.fringeShare,
      glowShare: t.glowShare,
    });
  }
  if (tiers.length === 0) return null;
  return {
    tiers,
    twoTierShare: r.twoTier.share,
    occlusion: r.occlusion,
    trackingReveal: reveal,
  };
}
