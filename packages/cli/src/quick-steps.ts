// `vox quick` step timings. One clock and back-to-back marks, so the rows always add up to the wall
// time of the command: nothing between two steps goes uncounted. A registered quick-clips scorer
// (the fast model) can take minutes inside the quickClips job; its time (`scorerMs`) is moved out of
// that row into a row of its own.

export interface QuickStep {
  step: string;
  /** Whole ms. */
  ms: number;
}

export interface StepClock {
  /** Ends the current step: the time since the last mark goes to `step` (added up when repeated). */
  mark(step: string): void;
  /** Moves `ms` (at most what `from` has) from row `from` into a new row `to`, placed after it. */
  split(from: string, to: string, ms: number): void;
  rows(): QuickStep[];
  /** Whole ms from the clock's start to the last mark; equals the sum of the rows. */
  totalMs(): number;
}

export function stepClock(now: () => number = () => performance.now()): StepClock {
  const start = Math.round(now());
  let last = start;
  const rows: QuickStep[] = [];
  return {
    mark(step) {
      const t = Math.round(now());
      const row = rows.find((r) => r.step === step);
      if (row) row.ms += t - last;
      else rows.push({ step, ms: t - last });
      last = t;
    },
    split(from, to, ms) {
      const i = rows.findIndex((r) => r.step === from);
      if (i < 0) return;
      const moved = Math.max(0, Math.min(Math.round(ms), rows[i]!.ms));
      rows[i]!.ms -= moved;
      rows.splice(i + 1, 0, { step: to, ms: moved });
    },
    rows: () => rows.map((r) => ({ ...r })),
    totalMs: () => last - start,
  };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The step table of the text report: one row per step, then the total. */
export function stepTable(rows: readonly QuickStep[], totalMs: number): string {
  const lines = [...rows.map((r) => [r.step, secs(r.ms)]), ['total', secs(totalMs)]];
  const w = Math.max(...lines.map(([s]) => s!.length));
  const v = Math.max(...lines.map(([, t]) => t!.length));
  return lines.map(([s, t]) => `${s!.padEnd(w)}  ${t!.padStart(v)}\n`).join('');
}
