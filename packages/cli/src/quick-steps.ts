// `vox quick` step timings. One clock and back-to-back marks, so the rows always add up to the wall
// time of the command: nothing between two steps goes uncounted. A registered quick-clips scorer
// (the fast model) can take minutes inside the quickClips job; its time (`scorerMs`) is moved out of
// that row into a row of its own. The wait for video highlights is capped at the grace the app
// uses (D-75, D-85): a job still running then is cancelled and the pick goes on without it.

import { HIGHLIGHTS_GRACE_MS } from '@vox/engine';

export interface QuickStep {
  step: string;
  /** Whole ms. */
  ms: number;
  /** Why the row looks the way it does (e.g. a capped wait); shown after the time. */
  note?: string;
}

export interface StepClock {
  /** Ends the current step: the time since the last mark goes to `step` (added up when repeated). */
  mark(step: string): void;
  /** Moves `ms` (at most what `from` has) from row `from` into a new row `to`, placed after it. */
  split(from: string, to: string, ms: number): void;
  /** Attaches a note to row `step`; no row, no note. */
  note(step: string, text: string): void;
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
    note(step, text) {
      const row = rows.find((r) => r.step === step);
      if (row) row.note = text;
    },
    rows: () => rows.map((r) => ({ ...r })),
    totalMs: () => last - start,
  };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The step table of the text report: one row per step, then the total. */
export function stepTable(rows: readonly QuickStep[], totalMs: number): string {
  const lines = [...rows.map((r) => [r.step, secs(r.ms), r.note]), ['total', secs(totalMs)]];
  const w = Math.max(...lines.map(([s]) => s!.length));
  const v = Math.max(...lines.map(([, t]) => t!.length));
  return lines
    .map(([s, t, n]) => `${s!.padEnd(w)}  ${t!.padStart(v)}${n ? `  (${n})` : ''}\n`)
    .join('');
}

/** The note on the "highlights wait" row when the grace ran out. */
export const HIGHLIGHTS_SKIPPED_NOTE = `capped at ${HIGHLIGHTS_GRACE_MS / 1000} s, highlights skipped`;
/** The `vox quick` reason when sound tags (D-83) were still running when the same grace ran out. */
export const SOUNDS_SKIPPED_NOTE = `capped at ${HIGHLIGHTS_GRACE_MS / 1000} s, sound tags skipped`;

/**
 * Waits for the highlights job (`done`) at most `graceMs` after the other stages. When the grace
 * runs out it calls `cancel` and waits for the job to settle (the helper is stopped), so nothing is
 * left running; `skipped` says the clips go on without highlights.
 */
export async function waitHighlights<T>(
  done: Promise<T>,
  cancel: () => void,
  graceMs: number = HIGHLIGHTS_GRACE_MS,
): Promise<{ value: T; skipped: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol('late');
  const first = await Promise.race([
    done,
    new Promise<typeof late>((r) => (timer = setTimeout(() => r(late), graceMs))),
  ]).finally(() => clearTimeout(timer));
  if (first !== late) return { value: first as T, skipped: false };
  cancel();
  return { value: await done, skipped: true };
}
