import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { detectShots } from '../../src/stages/shots.ts';

// Slow (D-16): needs `fixtures/out/cuts-2shot.mp4` from make.sh (built here when missing).
const fx = new URL('../fixtures/', import.meta.url).pathname;
const clip = `${fx}out/cuts-2shot.mp4`;
const truthFile = `${fx}out/cuts-2shot.cuts.json`;

interface Truth {
  fps: number;
  durationMs: number;
  cutsMs: number[];
}

describe('shots on cuts-2shot.mp4 (phase 04 step 9c)', () => {
  let truth: Truth;
  beforeAll(() => {
    if (!existsSync(clip) || !existsSync(truthFile)) {
      execFileSync('bash', [`${fx}make.sh`], { stdio: 'inherit' });
    }
    truth = JSON.parse(readFileSync(truthFile, 'utf8')) as Truth;
  }, 300_000);

  const frameMs = () => 1000 / truth.fps;

  function expectMatches(shots: { startMs: number; endMs: number }[]): void {
    expect(shots[0]?.startMs).toBe(0);
    expect(shots.at(-1)?.endMs).toBe(truth.durationMs);
    for (let i = 1; i < shots.length; i++) expect(shots[i]?.startMs).toBe(shots[i - 1]?.endMs);
    const cuts = shots.slice(1).map((s) => s.startMs);
    expect(cuts).toHaveLength(truth.cutsMs.length);
    truth.cutsMs.forEach((c, i) => {
      expect(Math.abs((cuts[i] ?? -1e9) - c)).toBeLessThanOrEqual(frameMs());
    });
  }

  test('every known cut is found within 1 frame and the shots cover the whole media', async () => {
    expectMatches(await detectShots({ input: clip, durationMs: truth.durationMs }));
  });

  test('the no-proxy path (original scaled to 360p) gives the same shot list within 1 frame', async () => {
    const proxyLike = await detectShots({ input: clip, durationMs: truth.durationMs });
    const scaled = await detectShots({
      input: clip,
      durationMs: truth.durationMs,
      scaleTo360: true,
    });
    expectMatches(scaled);
    expect(scaled).toHaveLength(proxyLike.length);
    scaled.forEach((s, i) => {
      expect(Math.abs(s.startMs - (proxyLike[i]?.startMs ?? -1e9))).toBeLessThanOrEqual(frameMs());
    });
  });
});
