/**
 * Phase 14e (clip speed, GATE 7): pure analysis of a render of speed-changed clips of the 90 s spike
 * source (barcode counter of the source frame, a white flash on every 60th source frame, a 10 ms
 * 1 kHz click at the same moment). Used by the `playbackRate` spike (`bench/speed.ts`) and by the
 * engine's `render/speed` slow test.
 */
import { CELLS, decodeBits, margin } from '../lib/barcode.ts';

/** One clip of the rendered sequence, in frames of the sequence rate. */
export interface SpeedClip {
  id: string;
  startF: number;
  durF: number;
  /** First source frame (the source runs at the sequence rate in these fixtures). */
  inF: number;
  speed: number;
}

/**
 * The source frame an output frame should show: the clip's media time is
 * `in + (t - start) × speed`, and a frame is shown from its own time until the next frame's time.
 */
export function expectedFrame(c: SpeedClip, f: number): number {
  return Math.floor(c.inF + (f - c.startF) * c.speed + 1e-6);
}

export interface SpeedFrameReport {
  checked: number;
  minMargin: number;
  byClip: Record<string, { checked: number; mismatches: number; maxAbsOff: number }>;
  mismatches: { f: number; clip: string; expected: number; got: number }[];
}

/** `counters` holds 16 gray cells per rendered frame read at the counter position. */
export function checkSpeedFrames(
  clips: readonly SpeedClip[],
  counters: Uint8Array,
  frames: number,
): SpeedFrameReport {
  const rep: SpeedFrameReport = { checked: 0, minMargin: 255, byClip: {}, mismatches: [] };
  for (const c of clips) {
    const row = { checked: 0, mismatches: 0, maxAbsOff: 0 };
    rep.byClip[c.id] = row;
    for (let f = c.startF; f < Math.min(frames, c.startF + c.durF); f++) {
      const cells = counters.subarray(f * CELLS, f * CELLS + CELLS);
      if (cells.length < CELLS) break;
      const got = decodeBits(cells);
      const expected = expectedFrame(c, f);
      rep.checked++;
      row.checked++;
      rep.minMargin = Math.min(rep.minMargin, margin(cells));
      if (got !== expected) {
        row.mismatches++;
        row.maxAbsOff = Math.max(row.maxAbsOff, Math.abs(got - expected));
        if (rep.mismatches.length < 50) rep.mismatches.push({ f, clip: c.id, expected, got });
      }
    }
  }
  return rep;
}

/**
 * Onset (s) of a click burst near `t` (search ±`win` s): the first sample whose magnitude reaches a
 * fifth of the window's peak. A matched filter would place the onset anywhere on a burst that a
 * time stretch made longer (20 ms at 0.5×), so the first loud sample is used instead.
 */
export function burstOnset(
  pcm: Float32Array,
  rate: number,
  t: number,
  win = 0.15,
  minPeak = 0.05,
): { onset: number; peak: number } | null {
  const a = Math.max(0, Math.round((t - win) * rate));
  const b = Math.min(pcm.length, Math.round((t + win) * rate));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  if (peak < minPeak) return null;
  for (let i = a; i < b; i++) {
    if (Math.abs(pcm[i]!) >= peak / 5) return { onset: i / rate, peak };
  }
  return null;
}

export interface SpeedSyncReport {
  frameMs: number;
  pairs: {
    clip: string;
    srcF: number;
    expectedF: number;
    flashF: number;
    onsetMs: number;
    /** Click onset minus the flash frame's start time. */
    offsetMs: number;
    /** Click onset minus the exact time the source moment lands on the timeline. */
    audioErrMs: number;
  }[];
  maxAbsOffsetMs: number;
  maxAbsAudioErrMs: number;
  missingFlash: number;
  missingClick: number;
}

/**
 * For every flash source frame (k × 60) inside a clip, away from its edges: find the flash in the
 * rendered picture (brightest of the expected frame ± 3 above the threshold) and the click onset
 * next to it. A/V offset = onset − flash frame start.
 */
export function checkSpeedSync(
  clips: readonly SpeedClip[],
  fps: number,
  flashLuma: Uint8Array,
  pcm: Float32Array,
  rate: number,
  threshold = 235,
): SpeedSyncReport {
  const frameMs = 1000 / fps;
  const rep: SpeedSyncReport = {
    frameMs,
    pairs: [],
    maxAbsOffsetMs: 0,
    maxAbsAudioErrMs: 0,
    missingFlash: 0,
    missingClick: 0,
  };
  for (const c of clips) {
    const srcEnd = c.inF + c.durF * c.speed;
    for (let srcF = Math.ceil(c.inF / 60) * 60; srcF < srcEnd; srcF += 60) {
      const k = (srcF - c.inF) / c.speed;
      // 2×: a flash on an odd output position is never shown; skip the clip edges (± 4 frames)
      if (Math.abs(k - Math.round(k)) > 1e-6 && c.speed > 1) continue;
      const expectedF = c.startF + Math.ceil(k - 1e-6);
      if (expectedF < c.startF + 4 || expectedF > c.startF + c.durF - 5) continue;
      let flashF = -1;
      let hi = threshold;
      for (let d = -3; d <= 3; d++) {
        const v = flashLuma[expectedF + d] ?? 0;
        if (v >= hi) {
          hi = v;
          flashF = expectedF + d;
        }
      }
      if (flashF < 0) {
        rep.missingFlash++;
        continue;
      }
      // the first frame of a flash held for two frames (0.5×)
      while (flashF > 0 && (flashLuma[flashF - 1] ?? 0) >= threshold) flashF--;
      const tFlash = flashF / fps;
      const o = burstOnset(pcm, rate, tFlash);
      if (!o) {
        rep.missingClick++;
        continue;
      }
      const exact = (c.startF + k) / fps;
      const offsetMs = (o.onset - tFlash) * 1000;
      const audioErrMs = (o.onset - exact) * 1000;
      rep.pairs.push({
        clip: c.id,
        srcF,
        expectedF,
        flashF,
        onsetMs: Math.round(o.onset * 1e5) / 100,
        offsetMs: Math.round(offsetMs * 100) / 100,
        audioErrMs: Math.round(audioErrMs * 100) / 100,
      });
      rep.maxAbsOffsetMs = Math.max(rep.maxAbsOffsetMs, Math.abs(offsetMs));
      rep.maxAbsAudioErrMs = Math.max(rep.maxAbsAudioErrMs, Math.abs(audioErrMs));
    }
  }
  rep.maxAbsOffsetMs = Math.round(rep.maxAbsOffsetMs * 100) / 100;
  rep.maxAbsAudioErrMs = Math.round(rep.maxAbsAudioErrMs * 100) / 100;
  return rep;
}
