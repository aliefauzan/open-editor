import { describe, expect, test } from 'vitest';
import { checkCuts, checkSync, clickOnset } from '../bench/analyze.ts';
import { cutFrames, expectedAt, makeMainSequence } from '../lib/model.ts';

const RATE = 48000;

function clicks(durS: number, at: number[]): Float32Array {
  const pcm = new Float32Array(Math.ceil(durS * RATE));
  for (const t of at) {
    const s = Math.round(t * RATE);
    for (let i = 0; i < 480; i++) pcm[s + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / RATE);
  }
  return pcm;
}

function cells(v: number): number[] {
  return Array.from({ length: 16 }, (_, i) => ((v >> (15 - i)) & 1 ? 230 : 20));
}

describe('clickOnset', () => {
  test('finds a click onset to the sample and its amplitude', () => {
    const pcm = clicks(1, [0.5123]);
    const c = clickOnset(pcm, RATE, 0.5)!;
    expect(Math.abs(c.onset - 0.5123)).toBeLessThan(1 / RATE + 1e-9);
    expect(c.amp).toBeCloseTo(0.8, 1);
  });
  test('returns null on silence', () => {
    expect(clickOnset(new Float32Array(RATE), RATE, 0.5)).toBeNull();
  });
});

describe('checkCuts', () => {
  const seq = makeMainSequence();
  const frames = seq.durF;
  const build = (shift: (f: number) => number) => {
    const spike = new Uint8Array(frames * 16);
    const phone = new Uint8Array(frames * 16);
    for (let f = 0; f < frames; f++) {
      const e = expectedAt(seq, f);
      const v = e ? e.frame + shift(f) : 0;
      (e?.src === 'phone' ? phone : spike).set(cells(v), f * 16);
    }
    return { spike, phone };
  };
  const band = new Uint8Array(frames * 4).map((_, i) => (i % 2 ? 200 : 10));

  test('exact render has no mismatches', () => {
    const r = checkCuts(
      seq,
      build(() => 0),
      band,
      4,
      frames,
    );
    expect(r.mismatches).toEqual([]);
    expect(r.checked).toBeGreaterThan(2000);
    expect(r.flat).toEqual([]);
  });

  test('a one-frame late cut is reported as a cut error', () => {
    const cut = cutFrames(seq)[5]!;
    const prev = expectedAt(seq, cut - 1)!;
    const counters = build(() => 0);
    counters.spike.set(cells(prev.frame + 1), cut * 16);
    const r = checkCuts(seq, counters, band, 4, frames);
    expect(r.cutErrors).toBe(1);
    expect(r.mismatches.length).toBe(1);
  });

  test('flat video band frames are listed', () => {
    const flat = new Uint8Array(frames * 4).fill(16);
    expect(
      checkCuts(
        seq,
        build(() => 0),
        flat,
        4,
        frames,
      ).flat.length,
    ).toBeGreaterThan(0);
  });
});

describe('checkSync', () => {
  test('clicks aligned with flash frames give ~0 offset', () => {
    const seq = makeMainSequence();
    const luma = new Uint8Array(seq.durF);
    const at: number[] = [];
    for (let f = 0; f < seq.durF; f++) {
      const e = expectedAt(seq, f);
      if (e && e.src === 'spike' && e.frame % 60 === 0 && e.itemId.startsWith('c')) {
        luma[f] = 255;
        at.push(f / 30);
      }
    }
    const r = checkSync(seq, luma, clicks(90, at), RATE);
    expect(r.pairs.length).toBeGreaterThan(10);
    expect(r.maxAbsOffsetMs).toBeLessThan(0.1);
  });
});
