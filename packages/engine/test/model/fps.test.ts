import { describe, expect, test } from 'vitest';
import { FPS_SET, frame, isFpsInSet, ms, snap, snapToSource } from '../../src/model/fps.ts';

const TEN_HOURS_MS = 10 * 3600 * 1000;

describe('frame grid', () => {
  test('the fixed set holds the seven rates of D-15', () => {
    expect(FPS_SET.map((f) => `${f.num}/${f.den}`)).toEqual([
      '24/1',
      '25/1',
      '30/1',
      '60/1',
      '24000/1001',
      '30000/1001',
      '60000/1001',
    ]);
    expect(isFpsInSet({ num: 30000, den: 1001 })).toBe(true);
    expect(isFpsInSet({ num: 29, den: 1 })).toBe(false);
  });

  for (const fps of FPS_SET) {
    test(`frame(ms(f)) === f for every frame of 10 hours at ${fps.num}/${fps.den}`, () => {
      const last = Math.ceil((TEN_HOURS_MS * fps.num) / (1000 * fps.den));
      for (let f = 0; f <= last; f++) {
        if (frame(ms(f, fps), fps) !== f) throw new Error(`round trip broke at frame ${f}`);
      }
    });

    test(`snap is idempotent and lands on the grid at ${fps.num}/${fps.den}`, () => {
      for (let t = 0; t < 5000; t += 7) {
        const s = snap(t, fps);
        expect(snap(s, fps)).toBe(s);
        expect(ms(frame(s, fps), fps)).toBe(s);
        expect(Math.abs(s - t)).toBeLessThanOrEqual(Math.ceil((500 * fps.den) / fps.num));
      }
    });
  }

  test('ms and frame use the D-15 formulas', () => {
    const ntsc = { num: 30000, den: 1001 };
    expect(ms(1, ntsc)).toBe(33);
    expect(ms(3, ntsc)).toBe(100);
    expect(ms(30, ntsc)).toBe(1001);
    expect(frame(1001, ntsc)).toBe(30);
  });

  test('snapToSource uses the media rate when present, else the sequence rate', () => {
    const seq = { num: 30, den: 1 };
    const src = { num: 30000, den: 1001 };
    // 1000 ms is not on the 29.97 grid; nearest source frame is 30 → 1001 ms
    expect(snapToSource(1000, src, seq)).toBe(1001);
    expect(snapToSource(1000, undefined, seq)).toBe(1000);
    // any source rate works, even outside the fixed set
    expect(snapToSource(100, { num: 90000, den: 1 }, seq)).toBe(100);
  });
});
