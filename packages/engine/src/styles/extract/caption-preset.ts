// The measured two-tier caption preset of an extracted style (styles Part C, plan phase 15 GATE 8
// round 3). The HTML is the engine's own template (`data/captions/two-tier.html`) with measured
// numbers, booleans and one colour written into it; nothing from the reference video or the vision
// model reaches the markup as text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../resources.ts';
import type { CaptionFonts } from './fontmatch.ts';

/** Fringe width (px at 1080 wide) when the reference shows one: about 1 px at 720. */
export const FRINGE_PX_1080 = 1.5;
/** A tier look needs this share of its lines (fringe, glow, box, knockout). */
const SHARE = 0.3;
/** Captions behind the subject: at least this many reference frames show it. */
export const BEHIND_MIN_FRAMES = 2;
/** Tracking reveal: at least this many single-word captions show it. */
export const REVEAL_MIN_EVENTS = 1;

export interface TwoTierLook {
  t1: { size: number; adv: number; track: number; italic: boolean };
  t2: { size: number; adv: number; track: number; stretch: number };
  box: { fill: string; padX: number; padY: number; rule: boolean; knockout: boolean };
  fringe: number;
  t1Fringe: boolean;
  glow: boolean;
  reveal: boolean;
  behindSubject: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: number, lo: number, hi: number, digits = 4) =>
  Number(clamp(Number.isFinite(v) ? v : lo, lo, hi).toFixed(digits));

/** The look the template gets, from the measured tiers (defaults where a tier is missing). */
export function twoTierLook(f: CaptionFonts): TwoTierLook {
  const t1 = f.tiers.find((t) => t.tier === 1);
  const t2 = f.tiers.find((t) => t.tier === 2);
  const fill = t2?.box?.fill && /^#[0-9A-F]{6}$/.test(t2.box.fill) ? t2.box.fill : '#FFFFFF';
  const fringeShare = Math.max(t2?.fringeShare ?? 0, t1?.fringeShare ?? 0);
  return {
    t1: {
      size: num((t1?.pick.sizePct ?? 4.5) / 100, 0.02, 0.08),
      adv: num(t1?.pick.advanceEm ?? 0.42, 0.2, 1),
      track: num(t1?.pick.trackingEm ?? 0, -0.08, 0.35, 3),
      italic: t1 ? t1.pick.italic : true,
    },
    t2: {
      size: num((t2?.pick.sizePct ?? 4) / 100, 0.02, 0.08),
      adv: num(t2?.pick.advanceEm ?? 0.62, 0.3, 1.4),
      track: num(t2?.pick.trackingEm ?? 0.02, -0.08, 0.35, 3),
      stretch: num(t2?.pick.stretch ?? 1, 1, 1.3, 2),
    },
    box: {
      fill,
      // a hair of padding at least, so the letters never touch the box edge
      padX: num(t2?.box?.padXEm ?? 0.3, 0.12, 0.8, 3),
      padY: num(t2?.box?.padYEm ?? 0.12, 0.08, 0.6, 3),
      rule: (t2?.box?.outlineShare ?? 0) >= SHARE || (t2?.box?.ruleShare ?? 0) >= SHARE,
      knockout: (t2?.box?.knockoutShare ?? 0) >= 0.5,
    },
    fringe: fringeShare >= SHARE ? FRINGE_PX_1080 : 0,
    t1Fringe: (t1?.fringeShare ?? 0) >= SHARE,
    glow: (t1?.glowShare ?? 0) >= SHARE * 0.8,
    reveal: f.trackingReveal.events >= REVEAL_MIN_EVENTS,
    behindSubject: f.occlusion.available && f.occlusion.behind >= BEHIND_MIN_FRAMES,
  };
}

/** The preset HTML: the engine template with the look written in. */
export function twoTierHtml(look: TwoTierLook, template?: string): string {
  const src = template ?? readFileSync(join(dataDir(), 'captions', 'two-tier.html'), 'utf8');
  const values: Record<string, string> = {
    T1_STYLE: look.t1.italic ? 'italic' : 'normal',
    T1_SIZE: String(look.t1.size),
    T1_ADV: String(look.t1.adv),
    T1_TRACK: String(look.t1.track),
    T2_SIZE: String(look.t2.size),
    T2_ADV: String(look.t2.adv),
    T2_TRACK: String(look.t2.track),
    T2_STRETCH: String(look.t2.stretch),
    BOX_FILL: look.box.fill,
    PAD_X: String(look.box.padX),
    PAD_Y: String(look.box.padY),
    RULE: String(look.box.rule),
    KNOCKOUT: String(look.box.knockout),
    FRINGE: String(look.fringe),
    T1_FRINGE: String(look.t1Fringe),
    GLOW: String(look.glow),
    REVEAL: String(look.reveal),
  };
  const html = src.replace(/@@([A-Z0-9_]+)@@/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`two-tier template: no value for ${k}`);
    return v;
  });
  return html;
}

const allCaps = (w: string) => {
  const letters = w.replace(/[^\p{L}]/gu, '');
  return (
    letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
  );
};
const p90 = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]!;

/**
 * The caption track a two-tier preset gives a sequence (D-93): tier 1 words and characters a line
 * from the reference's caption events (the 90th percentile; upper-case words are tier 2), two lines
 * (one a tier) and auto emphasis on, so the closing key words get the box.
 */
export function twoTierTrack(events: readonly { text: string }[]): {
  maxWords: number;
  maxLines: number;
  maxCharsPerLine: number;
  autoEmphasis: boolean;
} {
  const plain = events
    .map((e) => e.text.split(/\s+/u).filter((w) => w !== '' && !allCaps(w)))
    .filter((ws) => ws.length > 0);
  const words = plain.length ? p90(plain.map((ws) => ws.length)) : 5;
  const chars = plain.length ? p90(plain.map((ws) => ws.join(' ').length)) : 26;
  return {
    maxWords: Math.round(clamp(words, 2, 8)),
    maxLines: 2,
    maxCharsPerLine: Math.round(clamp(chars, 12, 40)),
    autoEmphasis: true,
  };
}
