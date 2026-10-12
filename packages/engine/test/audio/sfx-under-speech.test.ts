// A cue under quiet speech passes audio QA's `sfxUnderSpeech` (fix/sfx-under-speech, D-89). The
// speaker is gained to -14 LUFS over the whole clip but talks 20 dB quieter in its second half, as in
// the phase 12/13 agent clips; the vox kit's `type-key` lands there. At the file level (the mix
// before the fix) the check fails; with the mix's per-cue gain it passes, threshold unchanged.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { Cue } from '../../src/audio/cues.ts';
import { renderMix, type MixInput } from '../../src/audio/graph.ts';
import { SFX_GAIN_FLOOR_DB } from '../../src/audio/sfx-level.ts';
import type { Sequence } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { repoPyProject, runPyTool } from '../../src/py.ts';
import { emptySequence, F30, track } from '../helpers/project.ts';
import { clip, media } from '../compile/fixture.ts';

const REPO = new URL('../../../../', import.meta.url).pathname;
const TYPE_KEY = join(REPO, 'styles', 'vox', 'assets', 'sfx', 'type-key.wav');

const dir = mkdtempSync(join(tmpdir(), 'vox-sfx-speech-'));
mkdirSync(join(dir, 'media'));
// a "speaker": pink noise, 20 dB quieter after 3 s
const SPEECH = 'media/speaker.wav';
execFileSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  "anoisesrc=d=6:c=pink:r=48000:a=0.3:seed=11,volume='if(lt(t,3),1,0.1)':eval=frame",
  '-ar',
  '48000',
  '-ac',
  '2',
  join(dir, SPEECH),
]);

function integrated(file: string): number {
  const out = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8' },
  ).stderr.slice(-2000);
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(out)![1]);
}

function input(sfxGainsDb?: number[]): MixInput {
  const seq: Sequence = {
    ...emptySequence('seq_q', F30),
    audioTracks: [track('A1', [clip('it_sp', 'm_sp', 0, 6000, 0)])],
    captions: { ...CAPTION_DEFAULTS, overrides: [] },
  };
  const cues: Cue[] = [
    { atMs: 4500, sfx: 'type-key', type: 'appear', itemId: 'it_s', cueName: 'reveal' },
  ];
  return {
    seq,
    media: [
      media('m_sp', {
        kind: 'audio',
        path: SPEECH,
        audioPath: SPEECH,
        durationMs: 6000,
        width: undefined,
        height: undefined,
        fps: undefined,
        loudness: { integratedLufs: integrated(join(dir, SPEECH)), truePeakDb: -1 },
      }),
    ],
    projectDir: dir,
    cues,
    sfxFiles: { 'type-key': TYPE_KEY },
    durationMs: 6000,
    preset: 'youtube',
    ...(sfxGainsDb ? { sfxGainsDb } : {}),
  };
}

type Under = { id: string; status: string; minMarginLu: number | null };

/** The audio QA job's path: the mix and its stems, then the Python checks. */
async function qa(name: string, inp: MixInput): Promise<{ under: Under; gains?: number[] }> {
  const stemsDir = join(dir, `${name}-stems`);
  const r = await renderMix(inp, { out: join(dir, `${name}.wav`), stemsDir });
  const q = await runPyTool(
    'audioqa',
    {
      mix: r.out,
      stems: { sfx: r.stems!.sfx, speech: r.stems!.speech },
      cues: inp.cues.map((c) => ({ atMs: c.atMs, type: c.type, hero: false })),
      fps: 30,
      target: -14,
      outDir: join(dir, `${name}-qa`),
    },
    z.looseObject({ checks: z.array(z.looseObject({ id: z.string(), status: z.string() })) }),
    { pyProject: repoPyProject() },
  );
  const under = q.checks.find((c) => c.id === 'sfxUnderSpeech') as unknown as Under;
  return { under, ...(r.sfxGainsDb ? { gains: r.sfxGainsDb } : {}) };
}

describe('SFX under quiet speech (D-89)', () => {
  test('at the file level the cue fails sfxUnderSpeech (the bug)', async () => {
    const { under } = await qa('before', input([0]));
    expect(under.status).toBe('fail');
    expect(under.minMarginLu!).toBeLessThan(0);
  }, 120_000);

  test('the mix lowers the cue under the speech it lands on: sfxUnderSpeech passes', async () => {
    const { under, gains } = await qa('after', input());
    expect(under.status, JSON.stringify(under)).toBe('pass');
    expect(under.minMarginLu!).toBeGreaterThanOrEqual(6);
    expect(gains).toHaveLength(1);
    expect(gains![0]!).toBeLessThan(0);
    expect(gains![0]!).toBeGreaterThan(SFX_GAIN_FLOOR_DB);
  }, 120_000);
});
