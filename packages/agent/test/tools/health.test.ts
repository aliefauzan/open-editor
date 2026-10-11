// Frame health (step 15, D-15): black, white, blank and dark fixture frames are flagged from luma
// alone, with no vision model; a normal frame has no flags.
import { describe, expect, test } from 'vitest';
import { frameHealth, pngLumaStats } from '../../src/tools/health.ts';
import { solidColourPng } from '../../src/providers/probe.ts';
import { noise, rgbPng } from '../helpers/png.ts';

const W = 48;
const H = 32;

describe('frame health', () => {
  test('decodes every PNG row filter (stats of a known gradient)', () => {
    const png = rgbPng(W, H, (x) => [x * 5, x * 5, x * 5]);
    const s = pngLumaStats(png);
    expect(s.width).toBe(W);
    expect(s.mean).toBeCloseTo((47 * 5) / 2, 0);
  });

  test.each([
    [
      'black',
      rgbPng(W, H, (x, y) => {
        const v = Math.floor(noise(x, y) * 15);
        return [v, v, v];
      }),
      ['mostlyBlack'],
    ],
    [
      'white',
      rgbPng(W, H, (x, y) => {
        const v = 240 + Math.floor(noise(x, y) * 15);
        return [v, v, v];
      }),
      ['mostlyWhite'],
    ],
    ['blank (one flat grey)', solidColourPng([128, 128, 128], 32), ['blank']],
    [
      'dark',
      rgbPng(W, H, (x, y) => {
        const v = 18 + Math.floor(noise(x, y) * 30);
        return [v, v + 2, v];
      }),
      ['lowLuma'],
    ],
    [
      'normal',
      rgbPng(W, H, (x, y) => [Math.floor(noise(x, y) * 255), 120, Math.floor(noise(y, x) * 255)]),
      [],
    ],
  ])('%s frame', (_, png, flags) => {
    expect(frameHealth(png)).toEqual(flags);
  });

  test('a flat black frame is both mostlyBlack and blank', () => {
    expect(frameHealth(solidColourPng([0, 0, 0], 16))).toEqual(['mostlyBlack', 'blank']);
  });

  test('rejects data that is not a PNG', () => {
    expect(() => pngLumaStats(Buffer.from('nope'))).toThrow();
  });
});
