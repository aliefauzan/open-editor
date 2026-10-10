// Steps 13 / 13b (slow part): the mix rendered with ffmpeg. Click onsets within 1 frame of their
// timeline times; each loudness preset within 1 LU of its target with true peak <= -1 dBTP; stems sum
// to the mix before loudnorm; two sources 10 LU apart mix within 1 LU of each other.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { clickOnset } from '../../../../spike/bench/analyze.ts';
import { pcm } from '../../../../spike/bench/lib.ts';
import type { Cue } from '../../src/audio/cues.ts';
import {
  LOUDNESS_TARGETS,
  renderMix,
  type LoudnessPreset,
  type MixInput,
} from '../../src/audio/graph.ts';
import { ms } from '../../src/model/fps.ts';
import type { Item, MediaItem, Sequence } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { emptySequence, F30, track } from '../helpers/project.ts';
import { clip, media } from '../compile/fixture.ts';

const dir = mkdtempSync(join(tmpdir(), 'vox-mix-'));
mkdirSync(join(dir, 'media'));
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const lavfi = (expr: string, file: string) => {
  ff(['-f', 'lavfi', '-i', expr, '-ar', '48000', '-ac', '2', join(dir, 'media', file)]);
  return `media/${file}`;
};

// 1 kHz 10 ms bursts at every whole second of the source (phase 0 at the burst start)
const CLICKS = lavfi(
  "aevalsrc='if(lt(mod(t\\,1)\\,0.01)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=10",
  'clicks.wav',
);
const ONE_CLICK = lavfi(
  "aevalsrc='if(lt(t\\,0.01)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=0.5",
  'click.wav',
);
const PINK = lavfi('anoisesrc=d=12:c=pink:r=48000:a=0.2:seed=7', 'pink.wav');
const SINE = lavfi('sine=f=220:d=12:r=48000', 'sine.wav');
const QUIET = lavfi('anoisesrc=d=6:c=pink:r=48000:a=0.05:seed=3', 'quiet.wav');
const LOUD = lavfi('anoisesrc=d=6:c=pink:r=48000:a=0.158:seed=4', 'loud.wav');

const audio = (id: string, path: string, extra: Partial<MediaItem> = {}): MediaItem =>
  media(id, {
    kind: 'audio',
    path,
    audioPath: path,
    durationMs: 12000,
    width: undefined,
    height: undefined,
    fps: undefined,
    ...extra,
  });

function input(
  a1: Item[],
  a2: Item[],
  m: MediaItem[],
  durationMs: number,
  preset: LoudnessPreset = 'youtube',
  cues: Cue[] = [],
): MixInput {
  const seq: Sequence = {
    ...emptySequence('seq_mix', F30),
    audioTracks: [track('A1', a1), track('A2', a2)],
    captions: { ...CAPTION_DEFAULTS, overrides: [] },
  };
  return {
    seq,
    media: m,
    projectDir: dir,
    cues,
    sfxFiles: { click: join(dir, ONE_CLICK) },
    durationMs,
    preset,
  };
}

/** Integrated loudness and true peak (ebur128 summary) of a file or of a part of it. */
function loudness(file: string, fromS?: number, toS?: number): { i: number; tp: number } {
  const trim = fromS === undefined ? '' : `atrim=${fromS}:${toS},`;
  const out = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-af', `${trim}ebur128=peak=true`, '-f', 'null', '-'],
    { encoding: 'utf8' },
  ).stderr.slice(-2000);
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(out);
  const tp = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(out);
  if (!i || !tp) throw new Error(`no ebur128 summary: ${out}`);
  return { i: Number(i[1]), tp: tp[1] === '-inf' ? -Infinity : Number(tp[1]) };
}

const FRAME_S = 1 / 30;

describe('audio mix render (steps 13, 13b)', () => {
  test('click onsets in the mix are within 1 frame of their timeline times', async () => {
    const t2 = ms(130, F30); // 4333 ms, on the frame grid
    const at = ms(210, F30); // 7000 ms
    const inp = input(
      [clip('it_c1', 'm_clicks', 0, 3000, 500), clip('it_c2', 'm_clicks', t2, 2000, 2000)],
      [],
      [audio('m_clicks', CLICKS)],
      8000,
      'youtube',
      [{ atMs: at, sfx: 'click', type: 'appear', itemId: 'it_s', cueName: 'in' }],
    );
    const r = await renderMix(inp, { out: join(dir, 'clicks-mix.wav') });
    const x = await pcm(r.out, 48000, 0);
    // source bursts at 1, 2 (clip 1 from 0.5 s) and 3 (clip 2 from 2 s), and the sfx
    const expected = [0.5, 1.5, 2.5, t2 / 1000 + 1, at / 1000];
    for (const t of expected) {
      const o = clickOnset(x, 48000, t);
      expect(o, `click near ${t}`).not.toBeNull();
      expect(Math.abs(o!.onset - t), `click at ${t}: ${o!.onset}`).toBeLessThanOrEqual(FRAME_S);
    }
  }, 300_000);

  test.each(Object.keys(LOUDNESS_TARGETS) as LoudnessPreset[])(
    'preset %s: integrated loudness within 1 LU of the target, true peak <= -1 dBTP',
    async (preset) => {
      const inp = input(
        [clip('it_p', 'm_pink', 0, 10000, 0)],
        [clip('it_s', 'm_sine', 0, 10000, 0, { volume: 0.3 })],
        [audio('m_pink', PINK), audio('m_sine', SINE)],
        10000,
        preset,
      );
      const r = await renderMix(inp, { out: join(dir, `loud-${preset}.wav`) });
      const l = loudness(r.out);
      expect(
        Math.abs(l.i - LOUDNESS_TARGETS[preset]),
        `${preset}: ${l.i} LUFS`,
      ).toBeLessThanOrEqual(1);
      expect(l.tp, `${preset}: true peak ${l.tp}`).toBeLessThanOrEqual(-1);
    },
    300_000,
  );

  test('stems are written and sum (before loudnorm) to the mix', async () => {
    const inp = input(
      [clip('it_p', 'm_pink', 0, 4000, 0, { volume: 0.5, fadeInMs: 300 })],
      [clip('it_s', 'm_sine', 1000, 3000, 2000, { volume: 0.3, fadeOutMs: 500 })],
      [audio('m_pink', PINK), audio('m_sine', SINE)],
      5000,
      'youtube',
      [{ atMs: 2500, sfx: 'click', type: 'appear', itemId: 'it_x', cueName: 'in' }],
    );
    const stemsDir = join(dir, 'stems');
    const r = await renderMix(inp, { out: join(dir, 'pre.wav'), normalize: false, stemsDir });
    const mix = await pcm(r.out, 48000, 0);
    const [sp, ot, fx] = await Promise.all(
      (['speech', 'other', 'sfx'] as const).map((k) => pcm(r.stems![k], 48000, 0)),
    );
    expect(mix.length).toBe(5 * 48000);
    for (const s of [sp!, ot!, fx!]) expect(s.length).toBe(mix.length);
    let worst = 0;
    let energy = [0, 0, 0];
    for (let i = 0; i < mix.length; i++) {
      worst = Math.max(worst, Math.abs(sp![i]! + ot![i]! + fx![i]! - mix[i]!));
      energy = [energy[0]! + sp![i]! ** 2, energy[1]! + ot![i]! ** 2, energy[2]! + fx![i]! ** 2];
    }
    expect(worst).toBeLessThan(1e-4);
    for (const e of energy) expect(e).toBeGreaterThan(1);
  }, 300_000);

  test('two sources whose loudness is 10 LU apart mix within 1 LU of each other', async () => {
    const q = loudness(join(dir, QUIET));
    const l = loudness(join(dir, LOUD));
    expect(l.i - q.i).toBeGreaterThan(9);
    expect(l.i - q.i).toBeLessThan(11);
    const inp = input(
      [clip('it_q', 'm_quiet', 0, 5000, 0), clip('it_l', 'm_loud', 5000, 5000, 0)],
      [],
      [
        audio('m_quiet', QUIET, { loudness: { integratedLufs: q.i, truePeakDb: q.tp } }),
        audio('m_loud', LOUD, { loudness: { integratedLufs: l.i, truePeakDb: l.tp } }),
      ],
      10000,
    );
    const r = await renderMix(inp, { out: join(dir, 'levels.wav') });
    const a = loudness(r.out, 0.5, 4.5);
    const b = loudness(r.out, 5.5, 9.5);
    expect(Math.abs(a.i - b.i), `${a.i} vs ${b.i}`).toBeLessThanOrEqual(1);
  }, 300_000);
});
