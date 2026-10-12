// D-80: stills for the model are scaled to STILL_MAX_EDGE on the long edge; image tokens follow
// Anthropic's rule (≈ w × h / 750 after its own scaling).
import { describe, expect, test } from 'vitest';
import { pngLumaStats } from '../../src/tools/health.ts';
import {
  decodePng,
  downscalePng,
  encodePng,
  imageTokens,
  pngSize,
  STILL_MAX_EDGE,
} from '../../src/tools/png.ts';
import { noise, rgbPng } from '../helpers/png.ts';

describe('PNG stills (D-80)', () => {
  test('a 1080p still comes back 768×432, same picture on average', () => {
    // left half red, right half blue
    const big = rgbPng(1920, 1080, (x) => (x < 960 ? [220, 20, 20] : [20, 20, 220]));
    const small = downscalePng(big);
    expect(STILL_MAX_EDGE).toBe(768);
    expect(pngSize(small)).toEqual({ width: 768, height: 432 });
    const d = decodePng(small);
    expect(d.channels).toBe(3);
    const at = (x: number, y: number) => [
      ...d.pixels.subarray((y * 768 + x) * 3, (y * 768 + x) * 3 + 3),
    ];
    expect(at(10, 200)).toEqual([220, 20, 20]);
    expect(at(700, 200)).toEqual([20, 20, 220]);
    expect(pngLumaStats(small).mean).toBeCloseTo(pngLumaStats(big).mean, 0);
    expect(small.length).toBeLessThan(big.length);
  });

  test('portrait stills cap the height; small or unreadable PNGs come back unchanged', () => {
    const tall = rgbPng(540, 960, (x, y) => [x % 256, y % 256, 90]);
    expect(pngSize(downscalePng(tall))).toEqual({ width: 432, height: 768 });
    const small = rgbPng(640, 360, () => [1, 2, 3]);
    expect(downscalePng(small)).toBe(small);
    const notPng = new Uint8Array([1, 2, 3]);
    expect(downscalePng(notPng)).toBe(notPng);
  });

  test('encodePng round-trips through the decoder', () => {
    const w = 37;
    const h = 11;
    const px = Buffer.alloc(w * h * 4);
    for (let i = 0; i < px.length; i++) px[i] = Math.floor(noise(i % w, Math.floor(i / w)) * 255);
    const d = decodePng(encodePng(w, h, 4, px));
    expect([d.width, d.height, d.channels, d.depth]).toEqual([w, h, 4, 8]);
    expect(d.pixels.equals(px)).toBe(true);
  });

  test('image tokens: 1080p hits the 1,600 ceiling, 768×432 is about 443', () => {
    const tokensOf = (w: number, h: number) => {
      const ihdr = rgbPng(1, 1, () => [0, 0, 0]);
      ihdr.writeUInt32BE(w, 16);
      ihdr.writeUInt32BE(h, 20);
      return imageTokens(ihdr);
    };
    expect(tokensOf(1920, 1080)).toBe(1600);
    expect(tokensOf(768, 432)).toBe(443);
    expect(tokensOf(200, 200)).toBe(54);
    expect(imageTokens(new Uint8Array([1]))).toBe(1600);
  });
});
