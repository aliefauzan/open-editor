/**
 * Items 1, 2, 3, 5 (main sequence) and 9 (NTSC): render the build with the HyperFrames CLI at
 * `--quality draft`, time it, sample the peak RSS of the render process tree, then read the burnt-in
 * counters (cut accuracy) and flash/click pairs (A/V sync) from the output.
 *
 *   node bench/render.ts [--seq main|ntsc] [--attempt N] [--evidence-dir DIR] [--reuse]
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { frameToSec, fpsString } from '../lib/frames.ts';
import {
  COUNTER_CROP,
  FLASH_CROP,
  LANDSCAPE_BOX,
  makeMainSequence,
  makeNtscSequence,
  type Sequence,
} from '../lib/model.ts';
import { hfEnv, run } from '../lib/proc.ts';
import { checkCuts, checkSync } from './analyze.ts';
import {
  RENDERS,
  emit,
  ensureBenchLock,
  grayStream,
  load,
  pcm,
  probeFrames,
  rel,
  treeRss,
  writeEvidence,
} from './lib.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : def;
};

export const HF_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve('hyperframes/package.json')),
  'bin',
  'hyperframes.mjs',
);

export interface RenderRun {
  ok: boolean;
  ms: number;
  peakRssBytes: number;
  samples: number;
  loadBefore: ReturnType<typeof load>;
  loadAfter: ReturnType<typeof load>;
  args: string[];
  stderrTail: string;
}

/** Renders `dir` to `out`; samples the RSS of the whole process tree every 250 ms. */
export async function renderBuild(dir: string, out: string, seq: Sequence): Promise<RenderRun> {
  mkdirSync(path.dirname(out), { recursive: true });
  const args = [
    'render',
    dir,
    '-o',
    out,
    '--quality',
    'draft',
    '--fps',
    fpsString(seq.fps),
    '--strict',
    // cold run: no content-addressed frame cache from a previous attempt
    '--frames-cache-dir',
    'off',
  ];
  let pid = 0;
  let peak = 0;
  let samples = 0;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      if (pid) {
        peak = Math.max(peak, await treeRss(pid));
        samples++;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  const loadBefore = load();
  const r = await run(process.execPath, [HF_BIN, ...args], {
    env: hfEnv(),
    onSpawn: (p) => (pid = p),
  });
  stop = true;
  await sampler;
  return {
    ok: r.code === 0 && existsSync(out),
    ms: Math.round(r.ms),
    peakRssBytes: peak,
    samples,
    loadBefore,
    loadAfter: load(),
    args: args.map((a) => (path.isAbsolute(a) ? rel(a) : a)),
    stderrTail: r.code === 0 ? '' : r.stderr.slice(-2000),
  };
}

/** Cut accuracy + A/V sync of a rendered file against the sequence model. */
export async function analyzeRender(seq: Sequence, file: string) {
  const { frames, rate } = await probeFrames(file);
  const band = [LANDSCAPE_BOX.x, LANDSCAPE_BOX.y, LANDSCAPE_BOX.w, LANDSCAPE_BOX.h] as const;
  const [land, phone, bandPx, flash, audio] = await Promise.all([
    grayStream(file, COUNTER_CROP.spike, 16, 1),
    grayStream(file, COUNTER_CROP.phone, 16, 1),
    grayStream(file, band, 32, 18),
    grayStream(file, FLASH_CROP, 1, 1),
    pcm(file),
  ]);
  const cuts = checkCuts(seq, { spike: land, ntsc: land, phone }, bandPx, 32 * 18, frames);
  const sync = checkSync(seq, flash, audio, 48000);
  return { frames, expectedFrames: seq.durF, rate, cuts, sync, audioSec: audio.length / 48000 };
}

async function main() {
  ensureBenchLock();
  const which = arg('--seq', 'main');
  const attempt = Number(arg('--attempt', '1'));
  const seq = which === 'ntsc' ? makeNtscSequence() : makeMainSequence();
  const dir = path.join(
    import.meta.dirname,
    '..',
    'out',
    which === 'ntsc' ? 'project-ntsc' : 'project',
  );
  const out = path.join(RENDERS, `${which}.mp4`);
  const reuse = process.argv.includes('--reuse') && existsSync(out);
  const r = reuse ? null : await renderBuild(dir, out, seq);
  if (r && !r.ok) {
    const fail = {
      item: which === 'ntsc' ? 9 : 3,
      pass: false,
      attempt,
      error: 'render failed',
      render: r,
    };
    writeEvidence(which === 'ntsc' ? 'B-ntsc.json' : 'B7-render.json', fail);
    emit(fail);
    process.exit(1);
  }
  const a = await analyzeRender(seq, out);
  const realSec = frameToSec(seq.durF, seq.fps);
  const frameMs = a.sync.frameMs;
  const cutPass =
    a.frames === seq.durF && a.cuts.mismatches.length === 0 && a.cuts.flat.length === 0;
  const syncPass = a.sync.pairs.length >= 5 && a.sync.maxAbsOffsetMs < frameMs;
  const cutSummary = {
    frames: a.frames,
    expectedFrames: seq.durF,
    checked: a.cuts.checked,
    cuts: a.cuts.cuts,
    mismatches: a.cuts.mismatches.length,
    cutErrors: a.cuts.cutErrors,
    flatFrames: a.cuts.flat.length,
    minDecodeMargin: a.cuts.minMargin,
  };
  const syncSummary = {
    pairs: a.sync.pairs.length,
    maxAbsOffsetMs: a.sync.maxAbsOffsetMs,
    meanOffsetMs: a.sync.meanOffsetMs,
    frameMs: Math.round(frameMs * 100) / 100,
    missingFlash: a.sync.missingFlash,
    missingClick: a.sync.missingClick,
  };
  if (which === 'ntsc') {
    const line = {
      item: 9,
      name: 'ntsc-30000/1001',
      pass: cutPass && syncPass,
      attempt,
      cut: { pass: cutPass, ...cutSummary },
      sync: { pass: syncPass, ...syncSummary },
      renderMs: r?.ms,
      load: r?.loadBefore,
    };
    writeEvidence('B-ntsc.json', {
      ...line,
      mismatches: a.cuts.mismatches.slice(0, 50),
      pairs: a.sync.pairs,
      render: r,
    });
    emit(line);
    return;
  }
  if (r) {
    const renderLine = {
      item: 3,
      name: 'render-speed',
      pass: r.ms <= 5 * realSec * 1000,
      attempt,
      renderMs: r.ms,
      xRealtime: Math.round((r.ms / 1000 / realSec) * 100) / 100,
      barMs: 5 * realSec * 1000,
      load: r.loadBefore,
    };
    const memLine = {
      item: 5,
      name: 'peak-rss',
      pass: r.peakRssBytes > 0 && r.peakRssBytes < 12 * 2 ** 30,
      attempt,
      peakRssGB: Math.round((r.peakRssBytes / 2 ** 30) * 100) / 100,
      samples: r.samples,
      barGB: 12,
    };
    writeEvidence('B7-render.json', { ...renderLine, render: r });
    writeEvidence('B8-memory.json', memLine);
    emit(renderLine);
    emit(memLine);
  }
  const cutLine = { item: 1, name: 'cut-accuracy', pass: cutPass, attempt, ...cutSummary };
  writeEvidence('B5-cuts.json', {
    ...cutLine,
    mismatchList: a.cuts.mismatches.slice(0, 200),
    flatList: a.cuts.flat.slice(0, 200),
  });
  emit(cutLine);
  const syncLine = { item: 2, name: 'av-sync', pass: syncPass, attempt, ...syncSummary };
  writeEvidence('B6-avsync.json', { ...syncLine, pairList: a.sync.pairs });
  emit(syncLine);
}

if (import.meta.main) await main();
