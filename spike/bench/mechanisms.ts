/**
 * Item 7, render side: the four compile mechanisms read back from the draft render of the main
 * sequence (bench/render.ts writes out/renders/main.mp4).
 *
 * - per-instance vars (`data-vox-vars`, 8 scenes + 2 nested panels mounted): swatch colour;
 * - scoped tokens: `--tok-accent` box colour per instance;
 * - muted `<video>` + separate `<audio>`: click amplitude equals the source (no doubled audio);
 * - GSAP volume tween: click at frame 2640 / click at 2580 ≈ 0.4 (linear 1 → 0.1 over 2600-2660).
 *
 *   node bench/mechanisms.ts [--evidence-dir DIR]
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { frameToSec } from '../lib/frames.ts';
import { makeMainSequence, type AudioItem } from '../lib/model.ts';
import { runOk } from '../lib/proc.ts';
import { COLOR_TOL, colorDist, hexRgb, meanRgb, mechanismProbes } from '../lib/probes.ts';
import { clickOnset } from './analyze.ts';
import { OUT, RENDERS, emit, pcm, writeEvidence } from './lib.ts';

const W = 1080;
const H = 1920;

/** Full RGB frames for the listed frame numbers, in ascending order. */
async function framesAt(file: string, frames: number[]): Promise<Map<number, Uint8Array>> {
  const sel = frames.map((f) => `eq(n\\,${f})`).join('+');
  const r = await runOk('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `select='${sel}'`,
    '-fps_mode',
    'passthrough',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  const size = W * H * 3;
  const out = new Map<number, Uint8Array>();
  const sorted = [...frames].sort((a, b) => a - b);
  sorted.forEach((f, i) => out.set(f, r.stdout.subarray(i * size, (i + 1) * size)));
  return out;
}

export async function checkRenderMechanisms(file: string) {
  const seq = makeMainSequence();
  const probes = mechanismProbes(seq);
  const frames = await framesAt(
    file,
    probes.map((p) => p.f),
  );
  const points = probes.flatMap((p) =>
    p.points.map((pt) => {
      const got = meanRgb(frames.get(p.f)!, W, pt.box);
      const dist = colorDist(got, hexRgb(pt.expect));
      return {
        f: p.f,
        id: pt.id,
        what: pt.what,
        expect: pt.expect,
        got,
        dist,
        ok: dist <= COLOR_TOL,
      };
    }),
  );
  const vars = points.filter((p) => p.what === 'swatch');
  const tokens = points.filter((p) => p.what === 'token');

  const rate = 48000;
  // Left channel: the render is dual-mono stereo, the source mono.
  const [mix, src] = await Promise.all([
    pcm(file, rate, 0),
    pcm(path.join(OUT, 'media', 'spike.m4a'), rate),
  ]);
  const last = seq.items.find((i) => i.kind === 'audio' && i.fade) as AudioItem;
  const fps = seq.fps;
  // Clicks every 60 source frames; the last clip starts at source frame 600 (a click).
  const at = (f: number) => frameToSec(f, fps);
  const c0 = clickOnset(mix, rate, at(last.startF));
  const c1 = clickOnset(mix, rate, at(last.startF + 60));
  const s0 = clickOnset(src, rate, frameToSec(last.inF, fps));
  const fade = last.fade!;
  const expectedRatio =
    fade.from + ((fade.to - fade.from) * (last.startF + 60 - fade.fromF)) / (fade.toF - fade.fromF);
  const volumeRatio = c0 && c1 ? Math.round((c1.amp / c0.amp) * 1000) / 1000 : null;
  const unityRatio = c0 && s0 ? Math.round((c0.amp / s0.amp) * 1000) / 1000 : null;

  const result = {
    vars: {
      pass: vars.every((p) => p.ok),
      instances: vars.length,
      worstDist: Math.max(...vars.map((p) => p.dist)),
    },
    tokens: {
      pass: tokens.every((p) => p.ok),
      instances: tokens.length,
      worstDist: Math.max(...tokens.map((p) => p.dist)),
    },
    mutedVideoSeparateAudio: {
      pass: unityRatio !== null && Math.abs(unityRatio - 1) <= 0.15,
      clickAmpRenderOverSource: unityRatio,
    },
    volumeTween: {
      pass: volumeRatio !== null && Math.abs(volumeRatio - expectedRatio) <= 0.06,
      ratio: volumeRatio,
      expected: Math.round(expectedRatio * 1000) / 1000,
    },
  };
  return { result, points };
}

async function main() {
  const file = path.join(RENDERS, 'main.mp4');
  if (!existsSync(file)) throw new Error('run bench/render.ts --seq main first');
  const { result, points } = await checkRenderMechanisms(file);
  const pass = Object.values(result).every((r) => r.pass);
  writeEvidence('B12-mechanisms-render.json', { item: 7, side: 'render', pass, ...result, points });
  emit({ item: 7, name: 'mechanisms-render', pass, ...result });
}

if (import.meta.main) await main();
