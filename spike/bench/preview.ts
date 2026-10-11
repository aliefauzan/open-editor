/**
 * Items 4, 6 and 7 (preview side), and the heavy-scene fps margin: runs electron/main.ts on the
 * preview build (out/preview, from make-project.ts) under the bench lock and writes the evidence.
 *
 *   node bench/preview.ts [--mode opaque|same-origin] [--attempt N] [--evidence-dir DIR]
 *
 * Pass rules (engine spec "Spike", item 4):
 * - play: every 1 s window >= 24 fps (min of timeline fps and presented right video frames), no
 *   stall > 200 ms (rAF gap, clock frame-advance gap, gap between contiguous video frames);
 * - seek to a cut (frame f and f - 1, 20 cuts, at the frame midpoint and the frame start): right
 *   frame on screen within 300 ms;
 * - audio within 1 frame of picture during play and after 8 seek + play cycles: p95 of the
 *   steady-state samples of |presented picture - clock| and |audio - clock| <= 1 frame (each
 *   sample carries up to one display refresh of rVFC/rAF timing jitter; max is recorded too).
 * Item 6: one trimItem -> compile -> visible, scene-only patch and full reload, < 1 s.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { OUT, SPIKE, emit, ensureBenchLock, evidenceDir, load, writeEvidence } from './lib.ts';

ensureBenchLock();

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
};
const mode = arg('--mode', 'opaque') === 'same-origin' ? 'same-origin' : 'opaque';
const attempt = Number(arg('--attempt', '1'));
const TIMEOUT_MS = 15 * 60 * 1000;

type Stats = { n: number; p50: number | null; p95: number | null; max: number | null };
interface Result {
  mode: string;
  electron: string;
  chrome: string;
  box: unknown;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON written by electron/main.ts
  results: Record<string, any>;
  blocked: string[];
  notFound: string[];
  console: { level: string; message: string; url: string }[];
}

function runElectron(out: string): Promise<{ code: number | null; ms: number }> {
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const p = spawn(electron, ['electron/main.ts', '--out', out, '--mode', mode], {
      cwd: SPIKE,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        process.stderr.write(
          err
            .split('\n')
            .filter((l) => !l.includes('sandbox_extension'))
            .slice(-20)
            .join('\n'),
        );
      resolve({ code, ms: performance.now() - t0 });
    });
  });
}

const le = (s: Stats, bar: number) => s.p95 !== null && s.p95 <= bar;

async function main() {
  if (!existsSync(path.join(OUT, 'preview', 'index.html')))
    throw new Error('run make-project.ts first');
  const out = path.join(OUT, `preview-result-${mode}.json`);
  rmSync(out, { force: true });
  const loadBefore = load();
  const run = await runElectron(out);
  const loadAfter = load();
  if (!existsSync(out)) throw new Error(`electron exited ${run.code} without a result`);
  const r = JSON.parse(readFileSync(out, 'utf8')) as Result;
  const env = {
    mode,
    attempt,
    electron: r.electron,
    chrome: r.chrome,
    box: r.box,
    loadBefore,
    loadAfter,
    note: 'other phases were running on this machine during the measurement (load averages above)',
    wallS: Math.round(run.ms / 100) / 10,
    error: r.error,
    blockedNetworkRequests: r.blocked.length,
    notFound: r.notFound,
    consoleErrors: r.console.filter((c) => c.level === 'error' || c.level === '3').slice(0, 20),
  };
  const { play, seek, seekedge, avseek, mech, patch, reload } = r.results;
  const frameMs: number = play?.frameMs ?? 33.333;

  // item 4
  const playOk = !!play && play.minFps >= 24 && play.stall.maxMs <= 200;
  const avOk =
    !!play &&
    !!avseek &&
    le(play.pictureVsClockMs, frameMs) &&
    le(play.audioVsClockMs, frameMs) &&
    le(avseek.pictureVsClockMs, frameMs) &&
    le(avseek.audioVsClockMs, frameMs);
  const seekOk = !!seek?.pass && !!seekedge?.pass;
  const item4 = playOk && avOk && seekOk && r.blocked.length === 0 && !r.error;
  const { windows, ...playSummary } = play ?? {};
  writeEvidence(`B9-preview-${mode}.json`, {
    item: 4,
    pass: item4,
    parts: {
      play: playOk,
      avWithin1Frame: avOk,
      seekToCut: seekOk,
      noNetwork: r.blocked.length === 0,
    },
    ...env,
    play: playSummary,
    windows,
    avseek,
  });
  writeEvidence(`B10-seek-${mode}.json`, {
    item: 4,
    part: 'seek to a cut',
    pass: seekOk,
    ...env,
    seek,
    seekedge,
  });
  emit({
    item: 4,
    name: 'preview',
    mode,
    pass: item4,
    minFps: play?.minFps,
    maxStallMs: play?.stall.maxMs,
    seekWrong: (seek?.wrongFrame ?? 0) + (seekedge?.wrongFrame ?? 0),
    seekMaxMs: Math.max(seek?.latencyMs.max ?? Infinity, seekedge?.latencyMs.max ?? Infinity),
    pictureVsClockP95Ms: play?.pictureVsClockMs.p95,
    avSeekPictureP95Ms: avseek?.pictureVsClockMs.p95,
    load: loadBefore.load,
  });

  // heavy-scene fps margin (plan D-15)
  if (play) {
    writeEvidence(`B-fps-margin-${mode}.json`, {
      ...play.heavy,
      rule: 'margin < 20 % -> pre-render cache',
      ...env,
    });
    emit({ name: 'fps-margin', mode, ...play.heavy, preRenderCache: play.heavy.marginPct < 20 });
  }

  // item 6
  const item6 = !!patch?.pass;
  writeEvidence(`B11-op-preview-${mode}.json`, {
    item: 6,
    pass: item6,
    rule: 'op -> visible < 1 s through the scene-only patch path; full reload recorded',
    reloadUnder1s: !!reload?.pass,
    ...env,
    patch,
    reload,
  });
  emit({
    item: 6,
    name: 'op-preview',
    mode,
    pass: item6,
    patchMaxMs: patch?.latencyMs.max,
    reloadP50Ms: reload?.latencyMs.p50,
    reloadMaxMs: reload?.latencyMs.max,
  });

  // item 7, preview side
  if (mech) {
    const { points, ...m } = mech;
    writeEvidence(`B12-mechanisms-preview-${mode}.json`, {
      item: 7,
      side: 'preview',
      ...m,
      ...env,
      points,
    });
    emit({ item: 7, name: 'mechanisms-preview', mode, pass: m.pass });
  }
  process.stdout.write(`evidence: ${path.relative(SPIKE, evidenceDir())}\n`);
}

await main();
