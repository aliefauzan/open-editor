import { describe, expect, it } from 'vitest';
import {
  type AttemptResult,
  frameStats,
  median,
  parseBenchArgs,
  summarize,
} from '../../bench/timeline-stats.ts';

const steady = (n: number, stepMs: number) =>
  Array.from({ length: n }, (_, i) => 1000 + i * stepMs);

describe('frameStats', () => {
  it('reports fps from frame timestamps', () => {
    const s = frameStats(steady(61, 1000 / 60));
    expect(s.frames).toBe(60);
    expect(s.fps).toBeCloseTo(60, 6);
    expect(s.p95Ms).toBeCloseTo(16.667, 2);
    expect(s.maxMs).toBeCloseTo(16.667, 2);
    expect(s.over20Ms).toBe(0);
  });

  it('counts long frames and lowers fps', () => {
    const ts = [0, 16, 32, 82, 98];
    const s = frameStats(ts);
    expect(s.frames).toBe(4);
    expect(s.fps).toBeCloseTo((4 / 98) * 1000, 6);
    expect(s.maxMs).toBe(50);
    expect(s.over20Ms).toBe(1);
  });

  it('throws with fewer than two timestamps', () => {
    expect(() => frameStats([5])).toThrow(/at least 2/);
  });
});

describe('median', () => {
  it('takes the middle value, or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

const attempt = (drag: number, trim: number, linked: number, ok = true): AttemptResult => {
  const fs = (fps: number) => ({
    frames: 100,
    durationMs: 1,
    fps,
    p50Ms: 1,
    p95Ms: 1,
    maxMs: 1,
    over20Ms: 0,
    updates: ok ? 100 : 10,
    moves: 100,
  });
  return {
    drag: fs(drag),
    trim: fs(trim),
    linkedDrag: fs(linked),
    linkedCheck: {
      pass: ok,
      draggedStartMs: 1,
      partnerStartMs: ok ? 1 : 2,
      movedMs: 5000,
      followedDuringDrag: ok,
    },
    marqueeCheck: { pass: ok, expected: 50, selected: ok ? 50 : 49, domSelected: ok ? 50 : 49 },
    loadBefore: 1,
    loadAfter: 1,
  };
};

describe('summarize', () => {
  it('passes when median drag and trim fps are at least 50 and every check passes', () => {
    const s = summarize([attempt(60, 59, 58), attempt(61, 60, 57), attempt(59, 58, 40)], 50);
    expect(s.median).toEqual({ dragFps: 60, trimFps: 59, linkedDragFps: 57 });
    expect(s.pass).toBe(true);
    expect(s.nearBar).toBe(false);
    expect(s.outcome).toBe('library');
  });

  it('fails on fps below the bar and selects the custom canvas fallback', () => {
    const s = summarize([attempt(48, 60, 60), attempt(49, 60, 60), attempt(70, 60, 60)], 50);
    expect(s.pass).toBe(false);
    expect(s.outcome).toBe('custom-canvas');
  });

  it('fails when one attempt fails a prototype check', () => {
    const s = summarize([attempt(60, 60, 60), attempt(60, 60, 60, false), attempt(60, 60, 60)], 50);
    expect(s.checks).toEqual({ linked: '2/3', marquee: '2/3', gestures: '2/3' });
    expect(s.pass).toBe(false);
  });

  it('fails when a gesture moved the clip on fewer than half of the mouse moves', () => {
    const a = attempt(60, 60, 60);
    const s = summarize([a, a, { ...a, trim: { ...a.trim, updates: 49 } }], 50);
    expect(s.checks.gestures).toBe('2/3');
    expect(s.pass).toBe(false);
  });

  it('flags a result within 10 % of the bar', () => {
    const s = summarize([attempt(54, 60, 60), attempt(54, 60, 60), attempt(54, 60, 60)], 50);
    expect(s.pass).toBe(true);
    expect(s.nearBar).toBe(true);
  });
});

describe('parseBenchArgs', () => {
  it('defaults to 3 attempts, headless, no evidence', () => {
    expect(parseBenchArgs([])).toEqual({
      attempts: 3,
      evidenceDir: null,
      headed: false,
      gestureMs: 3000,
      browser: 'shell',
    });
  });

  it('reads --attempts, --evidence-dir, --headed and --gesture-ms', () => {
    expect(
      parseBenchArgs([
        '--attempts',
        '5',
        '--evidence-dir',
        'docs/evidence/phase-08',
        '--headed',
        '--gesture-ms=4000',
        '--browser',
        'chromium',
      ]),
    ).toEqual({
      attempts: 5,
      evidenceDir: 'docs/evidence/phase-08',
      headed: true,
      gestureMs: 4000,
      browser: 'chromium',
    });
  });

  it('rejects unknown flags and bad numbers', () => {
    expect(() => parseBenchArgs(['--nope'])).toThrow(/unknown/);
    expect(() => parseBenchArgs(['--attempts', '0'])).toThrow(/attempts/);
    expect(() => parseBenchArgs(['--evidence-dir'])).toThrow(/evidence-dir/);
    expect(() => parseBenchArgs(['--browser', 'firefox'])).toThrow(/browser/);
  });

  it('writes evidence only from a full run (3+ attempts, 3+ s gestures)', () => {
    expect(() => parseBenchArgs(['--evidence-dir', 'x', '--attempts', '1'])).toThrow(/evidence/);
    expect(() => parseBenchArgs(['--evidence-dir', 'x', '--gesture-ms', '500'])).toThrow(
      /evidence/,
    );
  });
});
