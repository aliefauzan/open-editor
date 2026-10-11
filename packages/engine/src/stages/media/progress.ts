// ffmpeg progress for long ingest steps (CFR copy, proxy, audio): `-progress pipe:1 -nostats`
// makes ffmpeg print `key=value` blocks on stdout; `out_time_us` (and the misnamed `out_time_ms`,
// also microseconds) over the probed duration gives 0..1. `progress=end` gives 1.

/** Global flags; they go before everything else in the argv (`withProgress`). */
export const PROGRESS_ARGS: readonly string[] = ['-progress', 'pipe:1', '-nostats'];

export function withProgress(argv: readonly string[]): string[] {
  return [...PROGRESS_ARGS, ...argv];
}

const HMS = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/;

/** Seconds from one progress line, or undefined. */
function outTimeSeconds(key: string, value: string): number | undefined {
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const us = Number(value);
    return Number.isFinite(us) && us >= 0 ? us / 1e6 : undefined;
  }
  if (key === 'out_time') {
    const m = HMS.exec(value);
    if (!m) return undefined;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return undefined;
}

/**
 * A stdout listener (`RunOptions.onStdout`) that calls `report(p)` with 0..1 as ffmpeg writes its
 * output. Without a duration only the end (1) is reported.
 */
export function progressReader(
  durationMs: number | undefined,
  report: (p: number) => void,
): (chunk: string) => void {
  let partial = '';
  const total = durationMs !== undefined && durationMs > 0 ? durationMs / 1000 : undefined;
  return (chunk) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (key === 'progress' && value === 'end') {
        report(1);
        continue;
      }
      if (total === undefined) continue;
      const t = outTimeSeconds(key, value);
      if (t !== undefined) report(Math.min(1, t / total));
    }
  };
}
