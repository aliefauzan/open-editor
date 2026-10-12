// SFX cue level under speech (fix/sfx-under-speech, plan D-89). A style's SFX files carry one fixed
// level, but speech in a clip is gained to the export target over the whole source (gain-to-target),
// so a quiet stretch of a speaker sits well under -14 LUFS and a hot file (`type-key`, `stamp`) lands
// level with the voice. Audio QA's `sfxUnderSpeech` wants every cue at least 6 LU under the speech
// in the 200 ms after its onset. So each cue gets its own gain at mix time: measured against the
// speech stem it lands on (K-weighted, BS.1770 at 48 kHz, the same measure as the QA), lowered until
// the margin plus a small headroom holds, never raised above the file level, never under a floor.
// The SFX already placed (earlier cues' tails) count in every window, so stacked cues hold too.
// Pure: the caller decodes the speech stem and the SFX files (mono, 48 kHz).

/** Audio QA's `sfxUnderSpeech` limit (`py/vox_py/audioqa_thresholds.json`, never loosened). */
export const SFX_MARGIN_LU = 6;
/** Extra distance the mix aims at, so the onset the QA detects and rounding never land on the edge. */
export const SFX_HEADROOM_LU = 1;
/** A cue is never louder than its file (the kit's levels were set by ear, GATE 3). */
export const SFX_GAIN_CEILING_DB = 0;
/** ...and never more than this under it; speech that would need more is barely speech. */
export const SFX_GAIN_FLOOR_DB = -30;
/** The QA's measurement window after an onset (`analysis.overlapWindowMs`). */
export const SFX_WINDOW_MS = 200;
/** The QA measures from the detected onset, a few ms into the file: windows start from the cue
 * time to this much later (the kit's onsets sit 7–37 ms in), every `SFX_STEP_MS`. */
export const SFX_ONSET_SLACK_MS = 60;
export const SFX_STEP_MS = 5;
/** Speech counts as active in a window when at least half its 20 ms frames are above -50 dBFS
 * (`analysis.speechFrameMs`, `speechFrameFloorDbfs`, `speechActiveMinFraction`). */
const FRAME_MS = 20;
const FRAME_FLOOR_DBFS = -50;
const ACTIVE_FRACTION = 0.5;
/** Speech read before each window, so the K-weighting filters have settled. */
const PREROLL_MS = 250;

const RATE = 48000;
const samples = (msValue: number) => Math.round((msValue * RATE) / 1000);

// ITU-R BS.1770-4 K-weighting at 48 kHz: stage 1 high shelf, stage 2 RLB high-pass.
const K1_B = [1.53512485958697, -2.69169618940638, 1.19839281085285] as const;
const K1_A = [1.0, -1.69065929318241, 0.73248077421585] as const;
const K2_B = [1.0, -2.0, 1.0] as const;
const K2_A = [1.0, -1.99004745483398, 0.99007225036621] as const;

function biquad(x: Float64Array, b: readonly number[], a: readonly number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = b[0]! * x0 + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
    y[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return y;
}

/** K-weighted copy of a mono 48 kHz signal (filters start from rest). */
export function kWeight(x: Float32Array | Float64Array): Float64Array {
  return biquad(biquad(Float64Array.from(x), K1_B, K1_A), K2_B, K2_A);
}

function speechActive(raw: Float32Array, from: number, n: number): boolean {
  const frame = samples(FRAME_MS);
  const count = Math.floor(n / frame);
  if (count === 0) return false;
  const floor = 10 ** (FRAME_FLOOR_DBFS / 20);
  let active = 0;
  for (let f = 0; f < count; f++) {
    let s = 0;
    for (let i = from + f * frame; i < from + (f + 1) * frame; i++) s += raw[i]! ** 2;
    if (Math.sqrt(s / frame) > floor) active++;
  }
  return active / count >= ACTIVE_FRACTION;
}

export interface SfxLevelCue {
  atMs: number;
  sfx: string;
}

interface Placed {
  start: number;
  kw: Float64Array;
  g: number;
}

interface Window {
  start: number;
  /** The largest K-weighted SFX mean square this window allows. */
  limit: number;
}

/**
 * The gain (dB, 0.01 dB steps, rounded down) of each cue so the SFX stays `SFX_MARGIN_LU +
 * SFX_HEADROOM_LU` under the speech in every window where speech is active, within
 * [`SFX_GAIN_FLOOR_DB`, `SFX_GAIN_CEILING_DB`]. `sfx` holds each file as the mix plays it (mono
 * 48 kHz); a cue whose file is missing gets 0 (the mix leaves it out). `speechAt(start, length)`
 * returns the mono speech stem from sample `start` (zeros outside it).
 */
export function sfxCueGainsDb(
  cues: readonly SfxLevelCue[],
  sfx: ReadonlyMap<string, Float32Array>,
  speechAt: (start: number, length: number) => Float32Array,
): number[] {
  const n = samples(SFX_WINDOW_MS);
  const pre = samples(PREROLL_MS);
  const slack = samples(SFX_ONSET_SLACK_MS);
  const step = samples(SFX_STEP_MS);
  const ratio = 10 ** (-(SFX_MARGIN_LU + SFX_HEADROOM_LU) / 10);
  const weighted = new Map<string, Float64Array>();
  const placed: Placed[] = [];
  const windows: Window[] = [];
  const gains: number[] = [];
  for (const c of cues) {
    const file = sfx.get(c.sfx);
    if (!file) {
      gains.push(0);
      continue;
    }
    let kw = weighted.get(c.sfx);
    if (!kw) {
      kw = kWeight(file);
      weighted.set(c.sfx, kw);
    }
    const start = samples(c.atMs);
    // this cue's windows: the speech after the cue, wherever the QA may find its onset
    const raw = speechAt(start - pre, pre + slack + n);
    const spk = kWeight(raw);
    for (let d = 0; d <= slack; d += step) {
      if (!speechActive(raw, pre + d, n)) continue;
      let p = 0;
      for (let i = pre + d; i < pre + d + n; i++) p += spk[i]! ** 2;
      windows.push({ start: start + d, limit: (p / n) * ratio });
    }
    // the largest linear gain that keeps every window this cue reaches under its limit
    let g = 10 ** (SFX_GAIN_CEILING_DB / 20);
    for (const w of windows) {
      if (w.start >= start + kw.length || w.start + n <= start) continue;
      let a = 0;
      let b = 0;
      let cc = 0;
      for (let j = 0; j < n; j++) {
        const t = w.start + j;
        const own = t - start >= 0 && t - start < kw.length ? kw[t - start]! : 0;
        let prev = 0;
        for (const q of placed) {
          const k = t - q.start;
          if (k >= 0 && k < q.kw.length) prev += q.g * q.kw[k]!;
        }
        a += own * own;
        b += 2 * prev * own;
        cc += prev * prev;
      }
      if (a <= 0) continue;
      // mean of (prev + g * own)^2 <= limit: a g^2 + b g + (cc - limit n) <= 0
      const c0 = cc - w.limit * n;
      if (c0 >= 0) {
        g = 0;
        break;
      }
      g = Math.min(g, (-b + Math.sqrt(b * b - 4 * a * c0)) / (2 * a));
    }
    const db = g > 0 ? 20 * Math.log10(g) : -Infinity;
    const clamped = Math.min(SFX_GAIN_CEILING_DB, Math.max(SFX_GAIN_FLOOR_DB, db));
    const out = Math.floor(clamped * 100) / 100 + 0; // + 0: never -0
    gains.push(out);
    placed.push({ start, kw, g: 10 ** (out / 20) });
  }
  return gains;
}
