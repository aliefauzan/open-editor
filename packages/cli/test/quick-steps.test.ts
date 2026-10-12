// The `vox quick` step table: the rows add up to the wall time, a registered scorer's time is a row
// of its own (taken out of quickClips, not added on top), and repeated steps (one render per clip)
// add up in one row. The highlights wait is capped at the shared 30 s grace (D-85).
import { HIGHLIGHTS_GRACE_MS } from '@vox/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  HIGHLIGHTS_SKIPPED_NOTE,
  stepClock,
  stepTable,
  waitHighlights,
} from '../src/quick-steps.ts';

function fakeClock(start = 1000.4) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe('vox quick step table', () => {
  test('rows add up to the wall time; the scorer is its own row inside quickClips', () => {
    const c = fakeClock();
    const clock = stepClock(c.now);
    const steps: [string, number][] = [
      ['setup', 120.3],
      ['ingest', 44_000],
      ['shots', 1500.6],
      ['transcribe', 42_800],
      ['facetrack', 40_000],
      ['highlights wait', 0],
      // the fast-model scorer took 538 s of this quickClips job
      ['quickClips', 538_100],
      ['render', 48_000],
      ['captions', 50.2],
      ['render', 48_400],
      ['captions', 49.9],
    ];
    for (const [step, ms] of steps) {
      c.tick(ms);
      clock.mark(step);
    }
    clock.split('quickClips', 'scorer', 538_000);
    const rows = clock.rows();
    const wall = Math.round(c.now()) - Math.round(1000.4);
    expect(clock.totalMs()).toBe(wall);
    expect(rows.reduce((s, r) => s + r.ms, 0)).toBe(wall);
    expect(rows.map((r) => r.step)).toEqual([
      'setup',
      'ingest',
      'shots',
      'transcribe',
      'facetrack',
      'highlights wait',
      'quickClips',
      'scorer',
      'render',
      'captions',
    ]);
    const ms = (step: string) => rows.find((r) => r.step === step)!.ms;
    expect(ms('scorer')).toBe(538_000);
    expect(ms('quickClips')).toBe(100);
    expect(ms('render')).toBe(96_400);
    // the total counts the scorer on top of the other steps (about 225 s, as in the D-75 gate)
    expect(clock.totalMs()).toBe(763_021);
    expect(clock.totalMs() - ms('scorer')).toBe(225_021);

    const table = stepTable(rows, clock.totalMs());
    expect(table).toContain('scorer           538.0 s\n');
    expect(table.trimEnd().split('\n').at(-1)).toBe(
      `total            ${(clock.totalMs() / 1000).toFixed(1)} s`,
    );
  });

  test('a scorer time over the quickClips row is capped at that row; no scorer, no row', () => {
    const c = fakeClock(0);
    const clock = stepClock(c.now);
    c.tick(500);
    clock.mark('quickClips');
    clock.split('quickClips', 'scorer', 900);
    expect(clock.rows()).toEqual([
      { step: 'quickClips', ms: 0 },
      { step: 'scorer', ms: 500 },
    ]);
    expect(clock.totalMs()).toBe(500);
    const plain = stepClock(c.now);
    c.tick(30);
    plain.mark('quickClips');
    plain.split('missing', 'scorer', 10);
    expect(plain.rows()).toEqual([{ step: 'quickClips', ms: 30 }]);
  });
});

describe('vox quick highlights wait (D-85)', () => {
  test('a highlights job still running 30 s after the other steps is cancelled and skipped', async () => {
    vi.useFakeTimers();
    try {
      let settle: (v: string) => void = () => {};
      // a fake highlights job that never finishes on its own; cancelling settles it
      const job = new Promise<string>((r) => (settle = r));
      const cancel = vi.fn(() => settle('cancelled'));
      const c = fakeClock(0);
      const clock = stepClock(c.now);
      const waiting = waitHighlights(job, cancel);
      let result: Awaited<typeof waiting> | undefined;
      void waiting.then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(HIGHLIGHTS_GRACE_MS - 1);
      expect(result).toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ value: 'cancelled', skipped: true });
      c.tick(HIGHLIGHTS_GRACE_MS);
      clock.mark('highlights wait');
      clock.note('highlights wait', HIGHLIGHTS_SKIPPED_NOTE);
      expect(clock.rows()).toEqual([
        { step: 'highlights wait', ms: 30_000, note: 'capped at 30 s, highlights skipped' },
      ]);
      expect(stepTable(clock.rows(), clock.totalMs())).toBe(
        'highlights wait  30.0 s  (capped at 30 s, highlights skipped)\ntotal            30.0 s\n',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('a highlights job done within 30 s is used and its timer cleared', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const r = await waitHighlights(Promise.resolve('done'), cancel);
      expect(r).toEqual({ value: 'done', skipped: false });
      expect(cancel).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
