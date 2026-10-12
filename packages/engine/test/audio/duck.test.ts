// Plan 14f (fast part): ducking in the mix graph. `sidechaincompress` per ducked track, after each
// clip's gain-to-target, keyed by the speech bus, before the final `amix`; snapshot of the graph and of
// the stems; unducked graphs stay as they were.
import { describe, expect, test } from 'vitest';
import { DUCK_FILTER, mixGraph, type MixInput } from '../../src/audio/graph.ts';
import type { Sequence } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { emptySequence, F30, track } from '../helpers/project.ts';
import { clip, media, PROJECT_DIR } from '../compile/fixture.ts';

function fixture(
  opts: { duck?: string[]; speech?: string[]; noSpeechClips?: boolean } = {},
): MixInput {
  const duck = new Set(opts.duck ?? ['A2']);
  const d = (id: string) => (duck.has(id) ? { duck: true } : {});
  const seq: Sequence = {
    ...emptySequence('seq_duck', F30),
    videoTracks: [track('V1', [clip('it_v1', 'm_a', 0, 6000, 0)])],
    audioTracks: [
      track(
        'A1',
        opts.noSpeechClips
          ? []
          : [clip('it_a1', 'm_a', 0, 3000, 1000), clip('it_a2', 'm_b', 3000, 3000, 0)],
        d('A1'),
      ),
      track(
        'A2',
        [
          clip('it_m1', 'm_music', 0, 3000, 0, { volume: 0.5 }),
          clip('it_m2', 'm_music', 3000, 3000, 3000),
        ],
        d('A2'),
      ),
      track('A3', [clip('it_o1', 'm_music', 0, 6000, 0)], d('A3')),
    ],
    captions: { ...CAPTION_DEFAULTS, sourceTrackIds: opts.speech ?? ['A1'], overrides: [] },
    sfx: false,
  };
  return {
    seq,
    media: [
      media('m_a', { loudness: { integratedLufs: -20, truePeakDb: -3 } }),
      media('m_b', { loudness: { integratedLufs: -30.5, truePeakDb: -9 } }),
      media('m_music', {
        kind: 'audio',
        width: undefined,
        height: undefined,
        fps: undefined,
        loudness: { integratedLufs: -16, truePeakDb: -2 },
      }),
    ],
    projectDir: PROJECT_DIR,
    cues: [],
    sfxFiles: {},
    durationMs: 6000,
    preset: 'youtube',
  };
}

describe('audio ducking (14f)', () => {
  test('snapshot: ducked track A2 under speech A1, A3 untouched; stems keep the duck', async () => {
    const stems = (['speech', 'other', 'sfx'] as const).map(
      (k) => `--- stem ${k}\n${mixGraph(fixture(), k).filter}`,
    );
    await expect(
      [`--- mix\n${mixGraph(fixture()).filter}`, ...stems, ''].join('\n'),
    ).toMatchFileSnapshot('__snapshots__/duck.txt');
  });

  test('sidechaincompress sits after the clip gain-to-target and before the final amix', () => {
    const f = mixGraph(fixture()).filter;
    const lines = f.split('\n');
    const dl = lines.findIndex((l) => l.includes(DUCK_FILTER));
    expect(dl).toBeGreaterThan(-1);
    const gain = lines.findIndex((l) => l.includes('volume=')); // first clip gain
    const finalMix = lines.findIndex((l) => l.endsWith('[mix]'));
    expect(gain).toBeLessThan(dl);
    expect(dl).toBeLessThan(finalMix);
    expect(f.match(/sidechaincompress/g)).toHaveLength(1);
    // the music clips carry their own gain to -14 LUFS (music at -16 -> +2 dB) before the duck
    expect(lines.filter((l) => l.includes('volume=2dB')).length).toBeGreaterThanOrEqual(2);
  });

  test('every ducked track gets its own compressor, and the detector is split once per track', () => {
    const g = mixGraph(fixture({ duck: ['A2', 'A3'] })).filter;
    expect(g.match(/sidechaincompress/g)).toHaveLength(2);
    expect(g).toContain('asplit=2[dk0][dk1]');
  });

  test('nothing ducks without the flag: the graph has no sidechaincompress', () => {
    expect(mixGraph(fixture({ duck: [] })).filter).not.toContain('sidechaincompress');
  });

  test('speech tracks are never ducked, and no speech clip means no duck', () => {
    expect(mixGraph(fixture({ duck: ['A1'] })).filter).not.toContain('sidechaincompress');
    expect(mixGraph(fixture({ noSpeechClips: true })).filter).not.toContain('sidechaincompress');
    // same sources and pads either way
    expect(mixGraph(fixture({ noSpeechClips: true })).filter).toContain('amix=inputs=3');
  });

  test('a muted ducked track is left out and the speech detector survives', () => {
    const f = fixture();
    f.seq.audioTracks[1]!.muted = true;
    const g = mixGraph(f).filter;
    expect(g).not.toContain('sidechaincompress');
    expect(g).not.toContain('asplit');
  });

  test('stem speech has no duck; stem other ducks against speech it does not contain', () => {
    const speech = mixGraph(fixture(), 'speech');
    expect(speech.filter).not.toContain('sidechaincompress');
    expect(speech.filter).not.toContain('asplit');
    const other = mixGraph(fixture(), 'other');
    expect(other.filter).toContain('sidechaincompress');
    expect(other.sources).toEqual({
      speech: ['it_a1', 'it_a2'],
      other: ['it_m1', 'it_m2', 'it_o1'],
      sfx: [],
    });
    // only the media files the stem needs plus the detector's: pops no input twice
    expect(new Set(other.inputs).size).toBe(other.inputs.length);
  });
});
