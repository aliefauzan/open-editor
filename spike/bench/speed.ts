/**
 * Phase 14e spike (GATE 7): does HyperFrames `data-playback-rate` render speed-changed video frame
 * exactly, and does an ffmpeg `atempo` mix stay in sync with it?
 *
 * The 90 s spike source (barcode counter, flash + click every 60 source frames) is placed three times
 * on a 30 fps 9:16 sequence: 2× (6 s from source 1 s), 0.5× (8 s from source 20 s) and 1× (3 s from
 * source 40 s). The engine compiles it as plain 1× clips with the timeline lengths; the spike then adds
 * `data-playback-rate` to the two changed `<video>` tags, renders with the pinned HyperFrames CLI,
 * builds the audio by hand (`atrim` → `atempo` → `adelay` → `amix`), muxes, and checks every frame's
 * counter and every flash/click pair.
 *
 *   node spike/bench/speed.ts --evidence-dir <dir> [--work <dir>] [--quality draft|standard]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openEngine } from '../../packages/engine/src/api.ts';
import { pictureRenderArgs, runHyperframes } from '../../packages/engine/src/export-api.ts';
import type { Item, Project } from '../../packages/engine/src/model/schema.ts';
import { grayStream, pcm, probeFrames } from './lib.ts';
import { checkSpeedFrames, checkSpeedSync, type SpeedClip } from './speed-analyze.ts';

const REPO = new URL('../../', import.meta.url).pathname;
const FIXTURES = process.env['VOX_FIXTURES'] ?? join(REPO, 'packages/engine/test/fixtures/out');
export const SPEED_SRC = join(FIXTURES, 'spike-source-1080p.mp4');

// `contain` on 1080x1920: scale 0.5625, top 656.25 (as packages/engine/test/compile/spike90-project.ts)
const S = 1080 / 1920;
const TOP = (1920 - 1080 * S) / 2;
export const COUNTER = [
  Math.round(40 * S),
  Math.round(TOP + 40 * S),
  Math.round(640 * S),
  Math.floor(40 * S),
] as const;
export const FLASH = [Math.round(1720 * S + 15), Math.round(TOP + 880 * S + 15), 60, 60] as const;

export const SPEED_CLIPS: readonly (SpeedClip & { sound: boolean })[] = [
  { id: 'it_x2', startF: 0, durF: 180, inF: 30, speed: 2, sound: true },
  { id: 'it_x05', startF: 180, durF: 480, inF: 600, speed: 0.5, sound: true },
  { id: 'it_x1', startF: 660, durF: 90, inF: 1200, speed: 1, sound: true },
  { id: 'it_x4', startF: 750, durF: 90, inF: 1500, speed: 4, sound: false },
  { id: 'it_x025', startF: 840, durF: 120, inF: 2100, speed: 0.25, sound: false },
];
/** atempo drops the first 1024 samples (48 kHz) of its input from the output; feed them as preroll. */
export const ATEMPO_PREROLL_SAMPLES = 1024;
const ms = (f: number) => Math.round((f * 1000) / 30);

/** The spike project: the five clips on V1, the sound ones linked on A1 (schemaVersion 2, migrated on open). */
export function speedProject(withSpeed: boolean): Project {
  const v: Item[] = [];
  const a: Item[] = [];
  for (const c of SPEED_CLIPS) {
    const base = {
      type: 'media' as const,
      mediaId: 'm_spike',
      startMs: ms(c.startF),
      durationMs: ms(c.startF + c.durF) - ms(c.startF),
      inMs: ms(c.inF),
      linkId: `ln_${c.id}`,
      ...(withSpeed && c.speed !== 1 ? { speed: c.speed } : {}),
    };
    v.push({ ...base, id: c.id, frame: { mode: 'contain' } } as Item);
    if (c.sound) a.push({ ...base, id: `${c.id}_a` } as Item);
  }
  const track = (id: string, items: Item[]) => ({
    id,
    locked: false,
    hidden: false,
    muted: false,
    syncLock: true,
    items,
  });
  return {
    schemaVersion: 2,
    id: 'p_speed',
    name: 'speed spike',
    version: 0,
    media: [
      {
        id: 'm_spike',
        kind: 'video',
        path: 'media/spike-source-1080p.mp4',
        proxyPath: 'media/spike-source-1080p.mp4',
        audioPath: 'media/spike-source-1080p.mp4',
        durationMs: 90000,
        width: 1920,
        height: 1080,
        hasAudio: true,
        fps: { num: 30, den: 1 },
        origin: { type: 'upload' },
        tags: [],
      },
    ],
    sequences: [
      {
        id: 'seq_speed',
        name: 'speed',
        canvas: { width: 1080, height: 1920, fps: { num: 30, den: 1 } },
        styleId: 'base',
        videoTracks: [track('V1', v)],
        audioTracks: [track('A1', a)],
        captions: null,
        sfx: false,
      },
    ],
    meta: {
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      sourceUrls: [],
    },
  } as unknown as Project; // a v2 file on purpose: the store migrates it on open
}

/** The hand-built mix: each clip's source range, time-stretched, delayed to its start. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-9) out.push(`atempo=${s}`);
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'evidence-dir': { type: 'string' },
      work: { type: 'string' },
      quality: { type: 'string', default: 'draft' },
    },
  });
  const evidence = values['evidence-dir'];
  if (!evidence) throw new Error('--evidence-dir is required');
  mkdirSync(evidence, { recursive: true });
  const work = values.work ?? mkdtempSync(join(tmpdir(), 'vox-speed-spike-'));
  const projectsDir = join(work, 'Projects');
  const dir = join(projectsDir, 'p_speed');
  mkdirSync(join(dir, 'media'), { recursive: true });
  symlinkSync(SPEED_SRC, join(dir, 'media', 'spike-source-1080p.mp4'));
  writeFileSync(join(dir, 'project.json'), JSON.stringify(speedProject(false), null, 2));
  writeFileSync(join(dir, 'history.jsonl'), '');

  const e = openEngine({
    projectsDir,
    stylesDirs: [join(REPO, 'styles')],
    config: async () => ({}),
  });
  const build = await e.compile('p_speed', 'seq_speed', { mode: 'render' });
  const buildDir = await e.writeBuild(build);
  const indexPath = join(buildDir, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  for (const c of SPEED_CLIPS) {
    if (c.speed === 1) continue;
    const tag = `<video id="${c.id}"`;
    if (!html.includes(tag)) throw new Error(`no ${tag} in the build`);
    html = html.replace(tag, `${tag} data-playback-rate="${c.speed}"`);
  }
  writeFileSync(indexPath, html);
  writeFileSync(join(evidence, 'spike-index.html'), html.replace(work, '<work>'));

  const picture = join(work, 'picture.mp4');
  const t0 = Date.now();
  await runHyperframes(
    pictureRenderArgs(buildDir, picture, { num: 30, den: 1 }, values.quality as 'draft'),
    {},
  );
  const renderMs = Date.now() - t0;

  // the mix, built by hand as the engine graph would (atrim on the source span, atempo, adelay)
  const parts: string[] = [];
  const labels: string[] = [];
  for (const [i, c] of SPEED_CLIPS.filter((x) => x.sound).entries()) {
    const inS = c.inF / 30;
    const spanS = (c.durF * c.speed) / 30;
    const pre = c.speed === 1 ? 0 : ATEMPO_PREROLL_SAMPLES / 48000;
    const chain = [
      `atrim=start=${inS - pre}:end=${inS + spanS}`,
      'asetpts=PTS-STARTPTS',
      'aresample=48000',
      ...atempoChain(c.speed),
      `atrim=end=${c.durF / 30}`,
      `adelay=${ms(c.startF)}:all=1`,
    ];
    parts.push(`[0:a]${chain.join(',')}[a${i}]`);
    labels.push(`[a${i}]`);
  }
  const total = SPEED_CLIPS.reduce((m, c) => Math.max(m, c.startF + c.durF), 0) / 30;
  const graph = `${parts.join(';')};${labels.join('')}amix=inputs=${labels.length}:normalize=0,atrim=end=${total}[out]`;
  const mix = join(work, 'mix.wav');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', SPEED_SRC, '-filter_complex', graph, '-map', '[out]',
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', mix,
  ]); // prettier-ignore
  const out = join(work, 'speed-spike.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', picture, '-i', mix, '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', out,
  ]); // prettier-ignore

  const { frames, rate } = await probeFrames(out);
  const [counters, flash, audio] = await Promise.all([
    grayStream(out, COUNTER, 16, 1),
    grayStream(out, FLASH, 1, 1),
    pcm(out),
  ]);
  const pictureRep = checkSpeedFrames(SPEED_CLIPS, counters, frames);
  const sync = checkSpeedSync(
    SPEED_CLIPS.filter((c) => c.sound),
    30,
    flash,
    audio,
    48000,
  );
  const report = {
    hyperframes: '0.8.145',
    attribute: 'data-playback-rate',
    quality: values.quality,
    renderMs,
    frames,
    rate,
    expectedFrames: total * 30,
    audioSec: Math.round((audio.length / 48000) * 1000) / 1000,
    clips: SPEED_CLIPS,
    graph,
    atempoPrerollSamples: ATEMPO_PREROLL_SAMPLES,
    picture: pictureRep,
    sync,
  };
  writeFileSync(join(evidence, 'spike-playbackrate.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      renderMs,
      frames,
      byClip: pictureRep.byClip,
      pairs: sync.pairs.length,
      maxAbsOffsetMs: sync.maxAbsOffsetMs,
      maxAbsAudioErrMs: sync.maxAbsAudioErrMs,
      missingFlash: sync.missingFlash,
      missingClick: sync.missingClick,
      work,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
