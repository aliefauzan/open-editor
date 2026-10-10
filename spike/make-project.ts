/**
 * Builds the spike projects (phase 01):
 *   out/project/        render build, main 90 s sequence (originals + phone CFR copy)
 *   out/preview/        preview build, same sequence (proxies, inline templates, vendored runtime)
 *   out/project-ntsc/   render build, 30000/1001 sequence (item 9)
 * Derived media (CFR copy, proxies, audio streams) are cached in out/media/.
 *
 * Usage: node make-project.ts   (fixtures from packages/engine/test/fixtures/make.sh, or VOX_FIXTURES)
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { compile, writeBuild, type MediaSet } from './lib/compile.ts';
import { FPS30, NTSC } from './lib/frames.ts';
import { makeMainSequence, makeNtscSequence } from './lib/model.ts';
import { runOk } from './lib/proc.ts';

export const SPIKE = import.meta.dirname;
export const OUT = path.join(SPIKE, 'out');
const FIXTURES_DIR = path.join(SPIKE, '..', 'packages', 'engine', 'test', 'fixtures');
export const FIXTURES = process.env.VOX_FIXTURES ?? path.join(FIXTURES_DIR, 'out');
const MEDIA = path.join(OUT, 'media');

const FF = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];

const fresh = (out: string, src: string) =>
  existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs;

async function derive(out: string, src: string, args: string[]): Promise<string> {
  if (!fresh(out, src)) await runOk('ffmpeg', [...FF, '-i', src, ...args, out]);
  return out;
}

/** Engine spec "Ingest analysis": CFR copy at the nearest fixed rate, libx264 -crf 18, audio copied. */
const cfrArgs = (rate: string) => [
  '-vf',
  `fps=${rate}`,
  '-c:v',
  'libx264',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'copy',
  '-movflags',
  '+faststart',
];

/** 540p H.264 proxy, keyframe every 15 frames (0.5 s at 30 fps). */
const proxyArgs = (scale: string) => [
  '-vf',
  `scale=${scale}`,
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-g',
  '15',
  '-keyint_min',
  '15',
  '-sc_threshold',
  '0',
  '-pix_fmt',
  'yuv420p',
  '-an',
  '-movflags',
  '+faststart',
];

const audioArgs = ['-vn', '-c:a', 'copy'];

export async function prepareMedia(): Promise<MediaSet> {
  const spikeSrc = path.join(FIXTURES, 'spike-source-1080p.mp4');
  const phoneSrc = path.join(FIXTURES, 'phone-vfr-20s.mp4');
  const ntscSrc = path.join(FIXTURES, 'ntsc-2997-20s.mp4');
  for (const f of [spikeSrc, phoneSrc, ntscSrc])
    if (!existsSync(f))
      throw new Error(`missing fixture ${f}: run bash packages/engine/test/fixtures/make.sh`);
  mkdirSync(MEDIA, { recursive: true });
  const m = (n: string) => path.join(MEDIA, n);
  const phoneCfr = await derive(m('phone.cfr.mp4'), phoneSrc, cfrArgs('30'));
  const [spikeProxy, phoneProxy, ntscProxy, spikeAudio, phoneAudio, ntscAudio] = await Promise.all([
    derive(m('spike.proxy.mp4'), spikeSrc, proxyArgs('960:540')),
    derive(m('phone.proxy.mp4'), phoneCfr, proxyArgs('540:960')),
    derive(m('ntsc.proxy.mp4'), ntscSrc, proxyArgs('960:540')),
    derive(m('spike.m4a'), spikeSrc, audioArgs),
    derive(m('phone.m4a'), phoneCfr, audioArgs),
    derive(m('ntsc.m4a'), ntscSrc, audioArgs),
  ]);
  const transcript = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, 'transcripts', 'spike-90s.json'), 'utf8'),
  ) as MediaSet['transcript'];
  return {
    // originals keep their fixture names in the build: media/spike-source-1080p.mp4 etc.
    spike: { render: spikeSrc, preview: spikeProxy, audio: spikeAudio, fps: FPS30 },
    phone: { render: phoneCfr, preview: phoneProxy, audio: phoneAudio, fps: FPS30 },
    ntsc: { render: ntscSrc, preview: ntscProxy, audio: ntscAudio, fps: NTSC },
    face: path.join(FIXTURES_DIR, 'assets', 'faces', 'face-a.jpg'),
    transcript,
  };
}

export const BUILDS = {
  render: path.join(OUT, 'project'),
  preview: path.join(OUT, 'preview'),
  ntsc: path.join(OUT, 'project-ntsc'),
} as const;

export async function makeAll(): Promise<void> {
  const media = await prepareMedia();
  const main = makeMainSequence();
  writeBuild(compile(main, 'render', media), BUILDS.render);
  writeBuild(compile(main, 'preview', media), BUILDS.preview);
  writeBuild(compile(makeNtscSequence(), 'render', media), BUILDS.ntsc);
}

if (import.meta.main) {
  const t0 = performance.now();
  await makeAll();
  console.log(
    JSON.stringify({ made: Object.values(BUILDS), ms: Math.round(performance.now() - t0) }),
  );
}
