import { FPS_SET, frame, ms } from '../../src/model/fps.ts';
import type { Fps } from '../../src/model/schema.ts';

export { FPS_SET };
export const onGridFor = (t: number, fps: Fps): boolean => ms(frame(t, fps), fps) === t;
export const fpsName = (f: Fps): string =>
  f.den === 1 ? `${f.num}` : `${(f.num / f.den).toFixed(3)}`;
