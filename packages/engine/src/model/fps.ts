// Frame grid (engine spec "Time and the frame grid", plan D-15). Times are integer ms;
// convert only through these helpers.

export interface Fps {
  num: number;
  den: number;
}

export const FPS_SET: readonly Fps[] = [
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30, den: 1 },
  { num: 60, den: 1 },
  { num: 24000, den: 1001 },
  { num: 30000, den: 1001 },
  { num: 60000, den: 1001 },
];

export const DEFAULT_FPS: Fps = { num: 30, den: 1 };

export function isFpsInSet(fps: Fps): boolean {
  return FPS_SET.some((f) => f.num === fps.num && f.den === fps.den);
}

/** Timeline ms of integer frame `f`: `Math.round(f * 1000 * den / num)`. */
export function ms(f: number, fps: Fps): number {
  return Math.round((f * 1000 * fps.den) / fps.num);
}

/** Nearest frame of a time: `Math.round(ms * num / (1000 * den))`. */
export function frame(t: number, fps: Fps): number {
  return Math.round((t * fps.num) / (1000 * fps.den));
}

/** Snap a time to the grid of `fps`. */
export function snap(t: number, fps: Fps): number {
  return ms(frame(t, fps), fps);
}

/** One frame in ms at `fps` (rounded; at least 1). */
export function frameMs(fps: Fps): number {
  return Math.max(1, ms(1, fps));
}

/** Snap a source offset (`inMs`) to the source's grid; media with no fps use the sequence grid. */
export function snapToSource(t: number, sourceFps: Fps | undefined, sequenceFps: Fps): number {
  return snap(t, sourceFps ?? sequenceFps);
}

export function fpsEquals(a: Fps, b: Fps): boolean {
  return a.num === b.num && a.den === b.den;
}
