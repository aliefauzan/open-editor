// Plan 14f (slow part): ducking rendered with ffmpeg on a speech-over-music project. The checked-in
// talking-head clip is the speech (A1, captions source); pink noise is the music (A2). With `duck` on A2
// the music stem drops while the speech stem is active and returns in the gaps; the speech stem is
// unchanged; `audioQa` on the ducked project passes with the unchanged thresholds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { pcm } from '../../../../spike/bench/lib.ts';
import type { HyperframesRun } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { renderMix } from '../../src/audio/graph.ts';
import type { MediaItem, Sequence } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { emptySequence, F30, track } from '../helpers/project.ts';
import { clip, media } from '../compile/fixture.ts';
import { REPO_STYLES, exportEngine, exportProject, type Fixture } from '../export/project.ts';

const LEN = 12000;
const fakeHf: HyperframesRun = async (args) => {
  const out = args[args.indexOf('-o') + 1]!;
  const html = readFileSync(join(args[1]!, 'index.html'), 'utf8');
  const dur = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? '1');
  execFileSync('ffmpeg', [
    ...[
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=gray:size=1080x1920:rate=30:duration=${dur}`,
    ],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out],
  ]);
};

let fx: Fixture;
beforeAll(async () => {
  fx = await exportProject(exportEngine({ stylesDirs: [REPO_STYLES], hyperframes: fakeHf }), LEN);
  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=14:c=pink:r=48000:a=0.2:seed=11'],
    ...['-ac', '2', join(fx.dir, 'media', 'm_music.wav')],
  ]);
  const op = async (o: unknown) => {
    const r = await fx.e.applyOp(fx.projectId, o as never, { actor: 'cli' });
    const bad = r.results.find((x) => x.status === 'failed');
    if (bad) throw new Error(JSON.stringify(bad));
  };
  await op({
    op: 'addMedia',
    args: {
      media: {
        id: 'm_music',
        kind: 'audio',
        path: 'media/m_music.wav',
        audioPath: 'media/m_music.wav',
        durationMs: 14000,
        hasAudio: true,
        origin: { type: 'upload' },
        tags: [],
      },
    },
  });
  await op({
    op: 'placeClip',
    args: {
      sequenceId: fx.seq,
      trackId: 'A2',
      mediaId: 'm_music',
      startMs: 0,
      inMs: 0,
      durationMs: LEN,
      withAudio: true,
    },
  });
}, 120_000);

/** dB of 100 ms windows of a mono signal. */
function windows(x: Float32Array): number[] {
  const n = 4800;
  const out: number[] = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += x[j]! * x[j]!;
    out.push(10 * Math.log10(Math.max(s / n, 1e-12)));
  }
  return out;
}

async function stems(tag: string) {
  const dir = join(fx.dir, 'duck-stems', tag);
  const r = await fx.e.mix(fx.projectId, fx.seq, {
    out: join(dir, 'mix.wav'),
    preset: 'youtube',
    stemsDir: dir,
  });
  return {
    mix: windows(await pcm(r.out, 48000)),
    speech: windows(await pcm(r.stems!.speech, 48000)),
    other: windows(await pcm(r.stems!.other, 48000)),
  };
}

describe('audio ducking render (14f)', () => {
  test('the music drops while the speech is active and returns in the gaps; speech is unchanged', async () => {
    const off = await stems('off');
    await fx.e.applyOp(
      fx.projectId,
      { op: 'updateTrack', args: { sequenceId: fx.seq, trackId: 'A2', duck: true } } as never,
      { actor: 'cli' },
    );
    const on = await stems('on');
    const n = Math.min(off.speech.length, on.speech.length) - 2;
    const active: number[] = [];
    const gap: number[] = [];
    for (let i = 0; i < n; i++) {
      const delta = on.other[i]! - off.other[i]!;
      if (off.speech[i]! > -45) active.push(delta);
      // a gap window: this 100 ms window holds no speech (the gaps between phrases are 400 ms)
      else if (off.speech[i]! < -55) gap.push(delta);
    }
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(active.length).toBeGreaterThan(20);
    expect(mean(active), `music change while speech is active: ${mean(active)} dB`).toBeLessThan(
      -8,
    );
    // the release is 400 ms, so a 400 ms gap only opens part of the way: it is clearly above the
    // ducked level, and the full recovery is checked on a long gap below
    expect(gap.length).toBeGreaterThan(3);
    expect(mean(gap), `gap ${mean(gap)} dB vs speech ${mean(active)} dB`).toBeGreaterThan(
      mean(active) + 3,
    );
    // the speech stem is byte-for-byte the same graph: same levels
    for (let i = 0; i < n; i++) expect(Math.abs(on.speech[i]! - off.speech[i]!)).toBeLessThan(0.01);
  }, 300_000);

  test('audio QA passes on the ducked project with the unchanged thresholds', async () => {
    const r = (await fx.e.jobs.wait(
      fx.e.jobs.start('audioQa', { projectId: fx.projectId }),
    )) as JobInfo<{ pass: boolean; checks: { id: string; status: string }[] }>;
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    const bad = r.result!.checks.filter((c) => c.status === 'fail');
    expect(bad, JSON.stringify(bad)).toEqual([]);
    expect(r.result!.pass).toBe(true);
  }, 300_000);
});

describe('audio ducking render, synthetic (14f)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vox-duck-'));
  mkdirSync(join(dir, 'media'));
  const lavfi = (expr: string, file: string) => {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      expr,
      '-ac',
      '2',
      join(dir, 'media', file),
    ]);
    return `media/${file}`;
  };
  // speech stand-in: 2 s of speech-level pink noise (about -15 dBFS RMS), then silence up to 6 s
  const SPEECH = lavfi('anoisesrc=d=2:c=pink:r=48000:a=0.7:seed=5,apad=whole_dur=6', 'talk.wav');
  const MUSIC = lavfi('anoisesrc=d=6:c=pink:r=48000:a=0.1:seed=9', 'music.wav');
  const audio = (id: string, path: string): MediaItem =>
    media(id, {
      kind: 'audio',
      path,
      audioPath: path,
      durationMs: 6000,
      width: undefined,
      height: undefined,
      fps: undefined,
    });

  async function other(duck: boolean): Promise<Float32Array> {
    const seq: Sequence = {
      ...emptySequence('seq_duck', F30),
      audioTracks: [
        track('A1', [clip('it_talk', 'm_talk', 0, 6000, 0)]),
        track('A2', [clip('it_music', 'm_music', 0, 6000, 0)], duck ? { duck: true } : {}),
      ],
      captions: { ...CAPTION_DEFAULTS, sourceTrackIds: ['A1'], overrides: [] },
    };
    const r = await renderMix(
      {
        seq,
        media: [audio('m_talk', SPEECH), audio('m_music', MUSIC)],
        projectDir: dir,
        cues: [],
        sfxFiles: {},
        durationMs: 6000,
        preset: 'youtube',
      },
      { out: join(dir, `mix-${duck}.wav`), normalize: false, stemsDir: join(dir, `stems-${duck}`) },
    );
    return pcm(r.stems!.other, 48000, 0);
  }
  const db = (x: Float32Array, fromS: number, toS: number) => {
    const part = x.subarray(Math.round(fromS * 48000), Math.round(toS * 48000));
    return 10 * Math.log10(part.reduce((a, v) => a + v * v, 0) / part.length);
  };

  test('the music drops at least 8 dB under speech and is back within 1 dB after the release', async () => {
    const off = await other(false);
    const on = await other(true);
    const under = db(on, 0.6, 1.9) - db(off, 0.6, 1.9);
    const after = db(on, 4, 5.5) - db(off, 4, 5.5);
    expect(under, `ducked by ${under} dB`).toBeLessThan(-8);
    expect(Math.abs(after), `after the release: ${after} dB`).toBeLessThan(1);
  }, 120_000);
});
