// Clip speed (engine spec "Clip speed", plan D-62): a media clip plays its source range
// `[inMs, inMs + span)` with `span = round(durationMs × speed)`; timeline time t shows source time
// `inMs + (t − startMs) × speed`.

/** Speeds a clip on a video track may have (steps of 0.01). */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
/** Speeds a clip on an audio track may have: `atempo` keeps sync within one frame here (spike). */
export const SOUND_SPEED_MIN = 0.5;
export const SOUND_SPEED_MAX = 2;

interface Timed {
  startMs: number;
  durationMs: number;
  inMs: number;
  speed?: number;
}

/** The clip's speed (absent = 1). */
export const speedOf = (it: { speed?: number }): number => it.speed ?? 1;

/** Source milliseconds the clip uses: `round(durationMs × speed)`. */
export const spanMs = (it: { durationMs: number; speed?: number }): number =>
  Math.round(it.durationMs * speedOf(it));

/** Source time shown at timeline time `tMs` (not rounded). */
export const sourceAt = (it: Timed, tMs: number): number =>
  it.inMs + (tMs - it.startMs) * speedOf(it);

/** Timeline time where source time `srcMs` plays (not rounded). */
export const timelineAt = (it: Timed, srcMs: number): number =>
  it.startMs + (srcMs - it.inMs) / speedOf(it);

/** Source milliseconds of a timeline length (rounded). */
export const toSourceMs = (it: { speed?: number }, ms: number): number =>
  Math.round(ms * speedOf(it));

/** A speed is valid when it is in range and has at most two decimals. */
export const isSpeedStep = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
