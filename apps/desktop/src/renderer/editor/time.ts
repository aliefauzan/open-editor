// Frame grid helpers (R3 "Times and ids"; the engine's `model/fps.ts` formulas, copied because the
// renderer never imports the engine): ms(f) = round(f·1000·den/num), frame(ms) = round(ms·num/(1000·den)).
import type { Fps } from '../../shared/project.ts';

export const frameOf = (ms: number, fps: Fps): number =>
  Math.round((ms * fps.num) / (1000 * fps.den));
export const msOf = (frame: number, fps: Fps): number =>
  Math.round((frame * 1000 * fps.den) / fps.num);
/** Snaps a time to the nearest frame. */
export const snapMs = (ms: number, fps: Fps): number => msOf(frameOf(ms, fps), fps);

/** `HH:MM:SS:FF` at the sequence's nominal frame rate. */
export function timecode(ms: number, fps: Fps): string {
  const nominal = Math.round(fps.num / fps.den);
  const f = frameOf(Math.max(0, ms), fps);
  const ff = f % nominal;
  const totalS = Math.floor(f / nominal);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(totalS / 3600))}:${p(Math.floor(totalS / 60) % 60)}:${p(totalS % 60)}:${p(ff)}`;
}

/** `m:ss.s` for lists (pins, cues). */
export function shortTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
