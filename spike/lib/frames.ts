/** Rational frame rates (engine spec "Time and the frame grid", D-15). */
export interface Fps {
  num: number;
  den: number;
}

export const FPS30: Fps = { num: 30, den: 1 };
export const NTSC: Fps = { num: 30000, den: 1001 };

/** Start time in seconds of integer frame `f`, as the JS double `f * den / num`. */
export const frameToSec = (f: number, fps: Fps): number => (f * fps.den) / fps.num;

/** Nearest integer frame of a time in seconds. */
export const secToFrame = (s: number, fps: Fps): number => Math.round((s * fps.num) / fps.den);

/** ffmpeg / HyperFrames notation: `30` or `30000/1001`. */
export const fpsString = (fps: Fps): string =>
  fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;

/** Duration of one frame in milliseconds. */
export const frameMs = (fps: Fps): number => (1000 * fps.den) / fps.num;
