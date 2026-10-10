// Frame-grid helpers used by the ops.
import { describe, expect, test } from 'vitest';
import { ms } from '../../src/model/fps.ts';
import { snapDown } from '../../src/ops/core.ts';
import { FPS_SET, fpsName } from '../helpers/grid.ts';

describe('snapDown', () => {
  test.each(FPS_SET.map((f) => [fpsName(f), f] as const))(
    '%s: a grid time snaps to itself; a time between frames to the frame before',
    (_n, fps) => {
      for (let f = 0; f < 2000; f++) {
        const t = ms(f, fps);
        expect(snapDown(t, fps)).toBe(t);
        const next = ms(f + 1, fps);
        if (next - t > 1) expect(snapDown(next - 1, fps)).toBe(t);
      }
    },
  );
});
