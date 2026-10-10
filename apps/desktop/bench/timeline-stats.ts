// GATE 4 timeline benchmark: pure helpers (frame stats, verdict, CLI args).

export interface FrameStats {
  /** Frame intervals measured (timestamps − 1). */
  frames: number;
  durationMs: number;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Intervals over 20 ms (below 50 fps). */
  over20Ms: number;
}

export interface GestureStats extends FrameStats {
  /** Position updates the prototype saw during the gesture (library moving/resizing events). */
  updates: number;
  /** Mouse moves sent during the gesture. */
  moves: number;
}

export interface LinkedCheck {
  pass: boolean;
  draggedStartMs: number;
  partnerStartMs: number;
  movedMs: number;
  /** The A1 partner was at the dragged clip's x while the mouse was still down. */
  followedDuringDrag: boolean;
}

export interface MarqueeCheck {
  pass: boolean;
  expected: number;
  selected: number;
  domSelected: number;
}

export interface AttemptResult {
  drag: GestureStats;
  trim: GestureStats;
  linkedDrag: GestureStats;
  linkedCheck: LinkedCheck;
  marqueeCheck: MarqueeCheck;
  loadBefore: number;
  loadAfter: number;
}

export interface Summary {
  median: { dragFps: number; trimFps: number; linkedDragFps: number };
  checks: { linked: string; marquee: string; gestures: string };
  bar: number;
  pass: boolean;
  /** Some median fps (drag, trim or linked drag) is within 10 % of the bar: re-run under the bench lock. */
  nearBar: boolean;
  outcome: 'library' | 'custom-canvas';
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

/** Stats from rAF timestamps (ms). fps = intervals / elapsed. */
export function frameStats(timestamps: readonly number[]): FrameStats {
  if (timestamps.length < 2) throw new Error('frameStats needs at least 2 timestamps');
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) intervals.push(timestamps[i]! - timestamps[i - 1]!);
  const durationMs = timestamps[timestamps.length - 1]! - timestamps[0]!;
  const sorted = [...intervals].sort((a, b) => a - b);
  return {
    frames: intervals.length,
    durationMs,
    fps: (intervals.length / durationMs) * 1000,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1]!,
    over20Ms: intervals.filter((d) => d > 20).length,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of no values');
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * GATE 4 pass rule (app spec "Timeline implementation"): median drag and trim fps ≥ bar, and the
 * linked-drag and marquee checks pass in every attempt, and every timed gesture really moved the
 * clip (updates on at least half of the mouse moves). Linked-drag fps is reported, not gated.
 */
export function summarize(attempts: readonly AttemptResult[], bar: number): Summary {
  const m = {
    dragFps: median(attempts.map((a) => a.drag.fps)),
    trimFps: median(attempts.map((a) => a.trim.fps)),
    linkedDragFps: median(attempts.map((a) => a.linkedDrag.fps)),
  };
  const linkedOk = attempts.filter((a) => a.linkedCheck.pass).length;
  const marqueeOk = attempts.filter((a) => a.marqueeCheck.pass).length;
  // A gesture counts only if the clip really moved on at least half of the mouse moves; an idle
  // page (missed grab, rejected move) would otherwise report a free 60 fps.
  const moved = (g: GestureStats) => g.moves > 0 && g.updates >= g.moves / 2;
  const gesturesOk = attempts.filter(
    (a) => moved(a.drag) && moved(a.trim) && moved(a.linkedDrag),
  ).length;
  const n = attempts.length;
  const pass =
    m.dragFps >= bar && m.trimFps >= bar && linkedOk === n && marqueeOk === n && gesturesOk === n;
  const near = (fps: number) => Math.abs(fps - bar) <= bar * 0.1;
  return {
    median: m,
    checks: {
      linked: `${linkedOk}/${n}`,
      marquee: `${marqueeOk}/${n}`,
      gestures: `${gesturesOk}/${n}`,
    },
    bar,
    pass,
    nearBar: near(m.dragFps) || near(m.trimFps) || near(m.linkedDragFps),
    outcome: pass ? 'library' : 'custom-canvas',
  };
}

export interface BenchArgs {
  attempts: number;
  evidenceDir: string | null;
  headed: boolean;
  gestureMs: number;
  /**
   * shell = Chromium headless shell: fixed 60 Hz begin-frames, independent of the display (default).
   * chromium = full Chromium (new headless or --headed): frames follow the macOS display link, which
   * drops to 30 Hz while the display sleeps, so it only measures well on an awake display.
   */
  browser: 'shell' | 'chromium';
}

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const out: BenchArgs = {
    attempts: 3,
    evidenceDir: null,
    headed: false,
    gestureMs: 3000,
    browser: 'shell',
  };
  const positiveInt = (flag: string, v: string | undefined) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`${flag} needs a positive integer, got ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const value = () => {
      const v = eq === -1 ? argv[++i] : raw.slice(eq + 1);
      if (v === undefined || v === '' || (eq === -1 && v.startsWith('--')))
        throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--attempts':
        out.attempts = positiveInt('--attempts', value());
        break;
      case '--evidence-dir':
        out.evidenceDir = value();
        break;
      case '--gesture-ms':
        out.gestureMs = positiveInt('--gesture-ms', value());
        break;
      case '--browser': {
        const v = value();
        if (v !== 'shell' && v !== 'chromium')
          throw new Error(`--browser must be shell or chromium, got ${v}`);
        out.browser = v;
        break;
      }
      case '--headed':
        out.headed = true;
        break;
      default:
        throw new Error(`unknown argument ${raw}`);
    }
  }
  if (out.evidenceDir !== null && (out.attempts < 3 || out.gestureMs < 3000))
    throw new Error('--evidence-dir needs a full run: --attempts >= 3 and --gesture-ms >= 3000');
  return out;
}
