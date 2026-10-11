// Steps 13 / 13b (fast part): the audio filter graph of a fixture timeline. Snapshot of the whole
// graph and of the loudnorm passes for every preset; per-source gain, denoise strengths, mutes, SFX.
import { describe, expect, test } from 'vitest';
import type { Cue } from '../../src/audio/cues.ts';
import {
  DENOISE_FILTERS,
  LOUDNESS_TARGETS,
  loudnormPass1,
  loudnormPass2,
  mixGraph,
  type LoudnessPreset,
  type MixInput,
} from '../../src/audio/graph.ts';
import type { Sequence } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { emptySequence, F30, track } from '../helpers/project.ts';
import { clip, image, media, PROJECT_DIR, scene } from '../compile/fixture.ts';

const SFX_DIR = '/vox-test/styles/kit/sfx';

function fixture(preset: LoudnessPreset = 'youtube'): MixInput {
  const seq: Sequence = {
    ...emptySequence('seq_mix', F30),
    videoTracks: [
      track('V1', [clip('it_v1', 'm_a', 0, 6000, 0)]),
      track('V2', [scene('it_s1', 'kit/swatch', '1.0.0', 1000, 2000, { label: 'x' })]),
    ],
    audioTracks: [
      track('A1', [
        clip('it_a1', 'm_a', 0, 3000, 1000, { denoise: 'light', fadeInMs: 200 }),
        clip('it_a2', 'm_b', 3000, 3000, 0, { denoise: 'off', volume: 1.5 }),
      ]),
      track('A2', [
        clip('it_m1', 'm_music', 0, 6000, 0, { denoise: 'strong', volume: 0.5, fadeOutMs: 1000 }),
      ]),
      { ...track('A3', [clip('it_x1', 'm_music', 0, 6000, 0)]), muted: true },
      track('A4', [clip('it_i1', 'm_img', 0, 1000, 0)]),
    ],
    captions: { ...CAPTION_DEFAULTS, overrides: [] },
  };
  const cues: Cue[] = [
    { atMs: 1000, sfx: 'pop', type: 'appear', itemId: 'it_s1', cueName: 'in' },
    { atMs: 2000, sfx: 'gone', type: 'land', itemId: 'it_s1', cueName: 'land' },
    { atMs: 4033, sfx: 'pop', type: 'appear', itemId: 'it_s1', cueName: 'again' },
  ];
  return {
    seq,
    media: [
      media('m_a', { loudness: { integratedLufs: -20, truePeakDb: -3 } }),
      media('m_b', { loudness: { integratedLufs: -30.5, truePeakDb: -9 } }),
      media('m_music', { kind: 'audio', width: undefined, height: undefined, fps: undefined }),
      image('m_img'),
    ],
    projectDir: PROJECT_DIR,
    cues,
    sfxFiles: { pop: `${SFX_DIR}/pop.wav` },
    durationMs: 6000,
    preset,
  };
}

const MEASURED = {
  input_i: '-19.52',
  input_tp: '-4.10',
  input_lra: '3.20',
  input_thresh: '-29.71',
  target_offset: '0.31',
};

describe('audio graph (steps 13, 13b)', () => {
  test('snapshot: the fixture graph and the loudnorm passes for every preset', async () => {
    const g = mixGraph(fixture());
    const presets = (Object.keys(LOUDNESS_TARGETS) as LoudnessPreset[]).map(
      (p) => `${p}\n  ${loudnormPass1(p)}\n  ${loudnormPass2(p, MEASURED)}`,
    );
    const stems = (['speech', 'other', 'sfx'] as const).map(
      (k) => `--- stem ${k}\n${mixGraph(fixture(), k).filter}`,
    );
    await expect(
      [
        `inputs\n${g.inputs.join('\n')}`,
        `sources ${JSON.stringify(g.sources)}`,
        `--- mix\n${g.filter}`,
        ...stems,
        '--- loudnorm',
        ...presets,
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('__snapshots__/graph.txt');
  });

  test('loudness presets: youtube -14, tiktok -12, broadcast -23 LUFS, aiming at -1.5 dBTP', () => {
    expect(loudnormPass1('youtube')).toBe('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json');
    expect(loudnormPass1('tiktok')).toContain('I=-12:TP=-1.5');
    expect(loudnormPass1('broadcast')).toContain('I=-23:TP=-1.5');
    expect(loudnormPass2('tiktok', MEASURED)).toContain(
      'measured_I=-19.52:measured_TP=-4.10:measured_LRA=3.20:measured_thresh=-29.71:offset=0.31:linear=true',
    );
  });

  test('per-source gain to the target: (target - integratedLufs) dB, per preset', () => {
    const at = (p: LoudnessPreset) => mixGraph(fixture(p)).filter.split('\n');
    const line = (lines: string[], n: number) => lines.find((l) => l.endsWith(`[s${n}];`))!;
    expect(line(at('youtube'), 0)).toContain('volume=6dB'); // -14 - -20
    expect(line(at('youtube'), 1)).toContain('volume=16.5dB'); // -14 - -30.5
    expect(line(at('broadcast'), 0)).toContain('volume=-3dB'); // -23 - -20
    expect(line(at('tiktok'), 1)).toContain('volume=18.5dB');
    // media without loudness get no gain
    expect(line(at('youtube'), 2)).not.toContain('dB');
  });

  test('denoise light and strong are the two fixed afftdn strengths; off adds no filter', () => {
    const lines = mixGraph(fixture()).filter.split('\n');
    expect(lines[0]).toContain(DENOISE_FILTERS.light);
    expect(lines[1]).not.toContain('afftdn');
    expect(lines[2]).toContain(DENOISE_FILTERS.strong);
    expect(DENOISE_FILTERS).toEqual({
      light: 'afftdn=nr=12:nf=-40',
      strong: 'afftdn=nr=24:nf=-30',
    });
  });

  test('muted tracks, images and unknown sfx are left out; stems split by captions sources', () => {
    const g = mixGraph(fixture());
    expect(g.sources).toEqual({
      speech: ['it_a1', 'it_a2'],
      other: ['it_m1'],
      sfx: ['it_s1:in:0', 'it_s1:again:2'],
    });
    expect(g.filter).toContain('amix=inputs=5:normalize=0');
    // sfx files are inputs once; adelay in samples on the frame grid
    expect(g.inputs.filter((f) => f.endsWith('pop.wav'))).toHaveLength(1);
    expect(g.filter).toContain('adelay=delays=193584S:all=1'); // 4033 ms
    const off = mixGraph({ ...fixture(), seq: { ...fixture().seq, sfx: false } });
    expect(off.sources.sfx).toEqual([]);
  });

  test('an empty stem is silence of the sequence length', () => {
    const f = fixture();
    const g = mixGraph({ ...f, cues: [] }, 'sfx');
    expect(g.inputs).toEqual([]);
    expect(g.filter).toBe(
      'anullsrc=r=48000:cl=stereo,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=288000[mix]',
    );
  });

  test('a zero duration is rejected', () => {
    expect(() => mixGraph({ ...fixture(), durationMs: 0 })).toThrow(/Bad mix duration/);
  });
});
