/** Pure analysis for items 1, 2 and 9 (unit-tested in spike/test/analyze.test.ts). */
import { CELLS, decodeBits, margin } from '../lib/barcode.ts';
import { frameToSec } from '../lib/frames.ts';
import { cutFrames, expectedAt, type Sequence, type VideoItem } from '../lib/model.ts';

export interface CutReport {
  frames: number;
  checked: number;
  cuts: number;
  /** Frames (any, not only at cuts) whose counter differs from the expected source frame. */
  mismatches: { f: number; expected: number; got: number; src: string; off: number }[];
  /** Mismatches at a cut frame or the frame before it. */
  cutErrors: number;
  /** Frames whose video band is flat (grey/black): stddev below the threshold. */
  flat: number[];
  minMargin: number;
}

/**
 * `counters[src]` holds the raw 16-byte cells per rendered frame read at that source's counter
 * position; `band` holds `bandBytes` gray samples per frame of the video band (flatness check).
 */
export function checkCuts(
  seq: Sequence,
  counters: Partial<Record<VideoItem['src'], Uint8Array>>,
  band: Uint8Array,
  bandBytes: number,
  frames: number,
  flatStd = 6,
): CutReport {
  const cuts = new Set(cutFrames(seq));
  const rep: CutReport = {
    frames,
    checked: 0,
    cuts: cuts.size,
    mismatches: [],
    cutErrors: 0,
    flat: [],
    minMargin: 255,
  };
  for (let f = 0; f < Math.min(frames, seq.durF); f++) {
    const e = expectedAt(seq, f);
    if (!e) continue;
    const raw = counters[e.src];
    if (!raw) continue;
    const cells = raw.subarray(f * CELLS, f * CELLS + CELLS);
    const got = decodeBits(cells);
    rep.checked++;
    rep.minMargin = Math.min(rep.minMargin, margin(cells));
    if (got !== e.frame) {
      rep.mismatches.push({ f, expected: e.frame, got, src: e.src, off: got - e.frame });
      if (cuts.has(f) || cuts.has(f + 1)) rep.cutErrors++;
    }
    const px = band.subarray(f * bandBytes, (f + 1) * bandBytes);
    if (stddev(px) < flatStd) rep.flat.push(f);
  }
  return rep;
}

export function stddev(px: ArrayLike<number>): number {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < px.length; i++) {
    s += px[i]!;
    s2 += px[i]! * px[i]!;
  }
  const m = s / px.length;
  return Math.sqrt(Math.max(0, s2 / px.length - m * m));
}

/**
 * Onset (s) of the 10 ms 1 kHz click nearest `t` (search ±`win` s): quadrature matched filter, the
 * onset is the lag with the largest response. Also returns the peak amplitude estimate.
 */
export function clickOnset(
  pcm: Float32Array,
  rate: number,
  t: number,
  win = 0.15,
): { onset: number; amp: number } | null {
  const n = Math.round(0.01 * rate);
  const sin = new Float32Array(n);
  const cos = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sin[i] = Math.sin((2 * Math.PI * 1000 * i) / rate);
    cos[i] = Math.cos((2 * Math.PI * 1000 * i) / rate);
  }
  const a = Math.max(0, Math.round((t - win) * rate));
  const b = Math.min(pcm.length - n, Math.round((t + win) * rate));
  let best = -1;
  let bestLag = -1;
  for (let lag = a; lag <= b; lag++) {
    let ps = 0;
    let pc = 0;
    for (let i = 0; i < n; i++) {
      const x = pcm[lag + i]!;
      ps += x * sin[i]!;
      pc += x * cos[i]!;
    }
    const m = ps * ps + pc * pc;
    if (m > best) {
      best = m;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  const amp = (2 * Math.sqrt(best)) / n;
  if (amp < 0.02) return null;
  return { onset: bestLag / rate, amp };
}

export interface SyncReport {
  pairs: { f: number; flashF: number; onsetMs: number; offsetMs: number; amp: number }[];
  maxAbsOffsetMs: number;
  meanOffsetMs: number;
  frameMs: number;
  missingFlash: number;
  missingClick: number;
}

/**
 * Item 2: for every frame where a linked-audio video shows a flash source frame (k mod 60 = 0), find
 * the flash in the rendered picture (brightest of f-3..f+3 above the threshold) and the click onset
 * near it; offset = onset - flash frame start.
 */
export function checkSync(
  seq: Sequence,
  flashLuma: Uint8Array,
  pcm: Float32Array,
  rate: number,
  threshold = 235,
): SyncReport {
  const frameMs = frameToSec(1, seq.fps) * 1000;
  const rep: SyncReport = {
    pairs: [],
    maxAbsOffsetMs: 0,
    meanOffsetMs: 0,
    frameMs,
    missingFlash: 0,
    missingClick: 0,
  };
  for (let f = 0; f < seq.durF; f++) {
    const e = expectedAt(seq, f);
    if (!e || e.src === 'phone' || e.frame % 60 !== 0 || !e.itemId.startsWith('c')) continue;
    // the whole ±3 window must stay inside the same clip, so the flash cannot belong to a neighbour
    const same = [-3, 3].every((d) => expectedAt(seq, f + d)?.itemId === e.itemId);
    if (!same) continue;
    let flashF = -1;
    let hi = threshold;
    for (let d = -3; d <= 3; d++) {
      const v = flashLuma[f + d] ?? 0;
      if (v >= hi) {
        hi = v;
        flashF = f + d;
      }
    }
    if (flashF < 0) {
      rep.missingFlash++;
      continue;
    }
    const tFlash = frameToSec(flashF, seq.fps);
    const c = clickOnset(pcm, rate, tFlash);
    if (!c) {
      rep.missingClick++;
      continue;
    }
    const offsetMs = (c.onset - tFlash) * 1000;
    rep.pairs.push({
      f,
      flashF,
      onsetMs: Math.round(c.onset * 1e5) / 100,
      offsetMs: Math.round(offsetMs * 100) / 100,
      amp: Math.round(c.amp * 1000) / 1000,
    });
  }
  const offs = rep.pairs.map((p) => p.offsetMs);
  rep.maxAbsOffsetMs = offs.length ? Math.max(...offs.map(Math.abs)) : NaN;
  rep.meanOffsetMs = offs.length
    ? Math.round((offs.reduce((s, x) => s + x, 0) / offs.length) * 100) / 100
    : NaN;
  return rep;
}
