// Clip speed in the mix (engine spec "Clip speed", plan D-62): a sped clip trims its source span with
// the `atempo` preroll, stretches it and cuts it to the timeline length; through real ffmpeg, the
// clicks of a click track land within one frame (33 ms at 30 fps) of their timeline times.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { burstOnset } from '../../../../spike/bench/speed-analyze.ts';
import { ATEMPO_PREROLL_SAMPLES, mixGraph, type MixInput } from '../../src/audio/graph.ts';
import type { Item, Sequence } from '../../src/model/schema.ts';
import { clip, media, PROJECT_DIR } from '../compile/fixture.ts';
import { emptySequence, F30, track } from '../helpers/project.ts';
import { tempDir } from '../helpers/store.ts';

function input(items: Item[], projectDir = PROJECT_DIR, durationMs = 9000): MixInput {
  const seq: Sequence = {
    ...emptySequence('seq_speed', F30),
    videoTracks: [track('V1')],
    audioTracks: [track('A1', items)],
  };
  return {
    seq,
    media: [
      media('m_click', {
        kind: 'audio',
        path: 'click.wav',
        audioPath: 'click.wav',
        durationMs: 20000,
        width: undefined,
        height: undefined,
        fps: undefined,
      }),
    ],
    projectDir,
    cues: [],
    sfxFiles: {},
    durationMs,
    preset: 'youtube',
  };
}

const chainOf = (g: { filter: string }, n: number) =>
  g.filter.split(';\n').find((l) => l.endsWith(`[s${n}]`))!;

describe('atempo in the mix graph', () => {
  test('1× clips keep the plain trim; sped clips get preroll, atempo and an exact cut', () => {
    const g = mixGraph(
      input([
        clip('it_1', 'm_click', 0, 1000, 500),
        clip('it_2', 'm_click', 1000, 3000, 1000, { speed: 2 }),
        clip('it_3', 'm_click', 4000, 4000, 10, { speed: 0.5 }),
      ]),
    );
    expect(chainOf(g, 0)).toMatch(/^\[0:a\]atrim=start=0\.5:end=1\.5,asetpts/);
    expect(chainOf(g, 0)).not.toMatch(/atempo/);
    // 2×: source 1000..7000; trim starts 1024 samples (21.333 ms) early
    expect(ATEMPO_PREROLL_SAMPLES).toBe(1024);
    expect(chainOf(g, 1)).toMatch(
      /atrim=start=0\.978667:end=7,asetpts=PTS-STARTPTS,aresample=48000.*,atempo=2,atrim=end_sample=144000,asetpts=PTS-STARTPTS,.*adelay=delays=48000S/,
    );
    // 0.5× from 10 ms into the source: only 480 samples of preroll exist, silence pads the rest
    expect(chainOf(g, 2)).toMatch(
      /atrim=start=0:end=2\.01,asetpts=PTS-STARTPTS,aresample=48000[^,]*,aformat=[^,]*,adelay=delays=544S:all=1,atempo=0\.5,atrim=end_sample=192000/,
    );
  });

  test('through ffmpeg, clicks of 2× and 0.5× clips land within one frame of their timeline times', () => {
    const dir = tempDir('vox-atempo-');
    // a 10 ms 1 kHz click every 0.25 s for 20 s
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i',
      "aevalsrc='if(lt(mod(t,0.25),0.01),0.8*sin(2*PI*1000*t),0)':s=44100:d=20:c=mono",
      join(dir, 'click.wav'),
    ]); // prettier-ignore
    const items = [
      clip('it_f', 'm_click', 0, 3000, 1000, { speed: 2 }), // source 1000..7000
      clip('it_s', 'm_click', 4000, 4000, 0, { speed: 0.5 }), // source 0..2000, no preroll room
    ];
    const g = mixGraph(input(items, dir), 'other');
    const raw = execFileSync(
      'ffmpeg',
      [
        '-v', 'error', ...g.inputs.flatMap((f) => ['-i', f]),
        '-filter_complex', g.filter, '-map', '[mix]', '-ac', '1', '-f', 'f32le', '-',
      ], // prettier-ignore
      { maxBuffer: 1 << 28 },
    );
    const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const errs: number[] = [];
    for (const it of items) {
      if (it.type !== 'media') continue;
      const sp = it.speed ?? 1;
      for (
        let src = Math.ceil(it.inMs / 250) * 250;
        src < it.inMs + it.durationMs * sp;
        src += 250
      ) {
        const t = (it.startMs + (src - it.inMs) / sp) / 1000;
        if (t * 1000 < it.startMs + 60 || t * 1000 > it.startMs + it.durationMs - 60) continue;
        const o = burstOnset(pcm, 48000, t, 0.06);
        expect(o, `${it.id} click at ${t}s`).not.toBeNull();
        errs.push((o!.onset - t) * 1000);
      }
    }
    expect(errs.length).toBeGreaterThan(20);
    expect(Math.max(...errs.map(Math.abs))).toBeLessThan(1000 / 30);
  });
});
