// GATE 4 timeline benchmark (phase 08 steps A1–A3; R7 "Measurements").
// Usage: node bench/timeline.ts [--attempts 3] [--evidence-dir <dir>] [--gesture-ms 3000]
//                               [--browser shell|chromium] [--headed]
// Prints the JSON report, then a one-line summary. Exit 0 = pass, 2 = fail, 1 = error.
// Run timed measurements under the bench lock: lockf -t 3600 <repo>/.git/vox-bench.lock pnpm …
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg, totalmem, version as osVersion } from 'node:os';
import path from 'node:path';
import { BENCH_TRACKS } from './timeline-proto/model.ts';
import { VIEWPORT, runTimelineBench } from './timeline-runner.ts';
import { parseBenchArgs, summarize } from './timeline-stats.ts';

const BAR_FPS = 50;
const EVIDENCE_NAME = 'A1-timeline-bench.json';

function pins(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  const d = pkg.devDependencies;
  const pick = ['react', 'react-dom', '@xzdarcy/react-timeline-editor', 'playwright', 'vite'];
  return Object.fromEntries(pick.map((k) => [k, d[k] ?? 'missing']));
}

const r1 = (n: number) => Math.round(n * 10) / 10;

async function main(): Promise<number> {
  const args = parseBenchArgs(process.argv.slice(2));
  const loadStart = loadavg();
  const run = await runTimelineBench({
    attempts: args.attempts,
    headed: args.headed,
    gestureMs: args.gestureMs,
    browser: args.browser,
    log: (line) => process.stderr.write(`[bench:timeline] ${line}\n`),
  });
  const summary = summarize(run.attempts, BAR_FPS);
  const report = {
    bench: 'timeline',
    gate: 'GATE 4',
    date: new Date().toISOString(),
    machine: {
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: availableParallelism(),
      memGB: Math.round(totalmem() / 2 ** 30),
      os: osVersion(),
      loadAvg1mStart: r1(loadStart[0]!),
    },
    browser: {
      name: 'Playwright Chromium',
      version: run.browserVersion,
      mode: run.mode,
      gpuRenderer: run.gpuRenderer,
    },
    pins: pins(),
    config: {
      items: 1000,
      tracks: BENCH_TRACKS.length,
      viewport: VIEWPORT,
      gestureMs: args.gestureMs,
      attempts: args.attempts,
      reactBuild: 'production (vite build)',
      measures:
        'fps = rAF callbacks per second on the renderer main thread while real mouse input ' +
        '(about one move per frame) drags or trims a clip; the window ends after the drop renders. ' +
        'Raster and GPU cost are not separately timed (the headless shell composites in software).',
    },
    attempts: run.attempts,
    ...summary,
  };
  const m = summary.median;
  const line =
    `timeline: drag ${r1(m.dragFps)} fps, trim ${r1(m.trimFps)} fps, linked drag ${r1(m.linkedDragFps)} fps ` +
    `(median of ${args.attempts}, 1,000 items / 8 tracks, Chromium ${run.mode}); ` +
    `linked startMs equal ${summary.checks.linked}; marquee 50 of 50 ${summary.checks.marquee}; gestures moved ${summary.checks.gestures}; ` +
    `bar ${BAR_FPS} fps -> ${summary.pass ? 'PASS' : 'FAIL'} (${summary.outcome})` +
    `${summary.nearBar ? '; within 10 % of the bar, re-run under the bench lock' : ''}`;
  if (args.evidenceDir) {
    mkdirSync(args.evidenceDir, { recursive: true });
    writeFileSync(
      path.join(args.evidenceDir, EVIDENCE_NAME),
      `${JSON.stringify({ ...report, summary: line }, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report)}\n${line}\n`);
  return summary.pass ? 0 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `[bench:timeline] error: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
