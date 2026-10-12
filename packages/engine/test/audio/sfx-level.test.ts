// SFX cue level under speech (fix/sfx-under-speech): each cue's gain is set from the speech it lands
// on, so audio QA's `sfxUnderSpeech` (SFX at least 6 LU under the speech in the 200 ms after its
// onset) holds for quiet speakers too. Pure part: K-weighting and the gain solver on synthetic
// signals; the mix graph carries the gains.
import { describe, expect, test } from 'vitest';
import type { Cue } from '../../src/audio/cues.ts';
import { mixGraph, type MixInput } from '../../src/audio/graph.ts';
import {
  SFX_GAIN_CEILING_DB,
  SFX_GAIN_FLOOR_DB,
  SFX_MARGIN_LU,
  SFX_ONSET_SLACK_MS,
  SFX_WINDOW_MS,
  kWeight,
  sfxCueGainsDb,
} from '../../src/audio/sfx-level.ts';
import type { Sequence } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { emptySequence, F30, track } from '../helpers/project.ts';
import { clip, media, PROJECT_DIR } from '../compile/fixture.ts';

const RATE = 48000;
const at = (msValue: number) => Math.round((msValue * RATE) / 1000);

/** Deterministic white noise with the given RMS (dBFS), `seconds` long. */
function noise(seconds: number, rmsDbfs: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let s = seed >>> 0;
  const amp = 10 ** (rmsDbfs / 20) * Math.sqrt(3); // uniform on [-1, 1] has RMS 1/sqrt(3)
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = amp * ((s / 2 ** 32) * 2 - 1);
  }
  return out;
}

/** A click-like SFX: a 5 ms silent pad, then a decaying noise burst peaking near 0 dBFS. */
function burst(seconds = 0.4, peak = 0.9, seed = 9): Float32Array {
  const x = noise(seconds, 0, seed);
  const pad = at(5);
  const out = new Float32Array(x.length);
  for (let i = pad; i < x.length; i++) {
    out[i] = (peak / Math.sqrt(3)) * x[i]! * Math.exp(-(i - pad) / at(120));
  }
  return out;
}

const reader = (speech: Float32Array) => (start: number, length: number) => {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const k = start + i;
    if (k >= 0 && k < speech.length) out[i] = speech[k]!;
  }
  return out;
};

const meanSquare = (x: Float32Array | Float64Array, a: number, n: number) => {
  let s = 0;
  for (let i = a; i < a + n; i++) s += (x[i] ?? 0) ** 2;
  return s / n;
};

/**
 * The QA measurement on the mixed stems: the SFX stem is every cue at its gain, and each cue's
 * margin is the K-weighted speech over the SFX in the 200 ms after `atMs + d` (for every d in the
 * onset slack where speech is active), as `sfxUnderSpeech` does after the detected onset.
 */
function margins(
  cues: { atMs: number; sfx: string }[],
  files: Map<string, Float32Array>,
  speech: Float32Array,
  gains: number[],
): number[] {
  const stem = new Float32Array(speech.length);
  cues.forEach((c, i) => {
    const f = files.get(c.sfx)!;
    const g = 10 ** (gains[i]! / 20);
    for (let k = 0; k < f.length && at(c.atMs) + k < stem.length; k++) {
      stem[at(c.atMs) + k]! += g * f[k]!;
    }
  });
  const sk = kWeight(stem);
  const spk = kWeight(speech);
  const n = at(SFX_WINDOW_MS);
  return cues.map((c) => {
    let worst = Infinity;
    for (let d = 0; d <= SFX_ONSET_SLACK_MS; d += 5) {
      const a = at(c.atMs + d);
      worst = Math.min(worst, 10 * Math.log10(meanSquare(spk, a, n) / meanSquare(sk, a, n)));
    }
    return worst;
  });
}

describe('kWeight', () => {
  test('a 997 Hz sine at 0 dBFS reads -3.01 LUFS (BS.1770: -0.691 + 10 log10 of the mean square)', () => {
    const x = new Float32Array(RATE * 2);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 997 * i) / RATE);
    const y = kWeight(x);
    const lufs = -0.691 + 10 * Math.log10(meanSquare(y, RATE, RATE));
    expect(Math.abs(lufs + 3.01)).toBeLessThan(0.05);
  });
});

describe('sfxCueGainsDb', () => {
  const files = new Map([['tap', burst()]]);

  test('a cue under quiet speech is lowered until it sits the QA margin under that speech', () => {
    // a speaker gained to -14 LUFS overall but quiet here: -24 dBFS RMS around the cue
    const speech = noise(3, -24);
    const cues = [{ atMs: 1000, sfx: 'tap' }];
    const before = margins(cues, files, speech, [0]);
    expect(before[0]).toBeLessThan(SFX_MARGIN_LU); // the file level fails the check
    const g = sfxCueGainsDb(cues, files, reader(speech));
    expect(g[0]).toBeLessThan(0);
    const after = margins(cues, files, speech, g);
    expect(after[0]).toBeGreaterThanOrEqual(SFX_MARGIN_LU);
    // lowered only as far as needed (the headroom is small), never to the floor
    expect(after[0]).toBeLessThan(SFX_MARGIN_LU + 3);
    expect(g[0]).toBeGreaterThan(SFX_GAIN_FLOOR_DB);
  });

  test('a cue already far under loud speech keeps the file level (never boosted)', () => {
    const speech = noise(3, -6);
    const quietTap = new Map([['tap', burst(0.4, 0.05)]]);
    const g = sfxCueGainsDb([{ atMs: 1000, sfx: 'tap' }], quietTap, reader(speech));
    expect(g).toEqual([SFX_GAIN_CEILING_DB]);
  });

  test('a cue in a speech pause keeps the file level', () => {
    const speech = noise(3, -20);
    speech.fill(0, at(800), at(1600));
    const g = sfxCueGainsDb([{ atMs: 1000, sfx: 'tap' }], files, reader(speech));
    expect(g).toEqual([SFX_GAIN_CEILING_DB]);
  });

  test('speech too quiet for any sane level gets the floor', () => {
    const speech = noise(3, -48); // active (above -50 dBFS) but whisper quiet
    const g = sfxCueGainsDb([{ atMs: 1000, sfx: 'tap' }], files, reader(speech));
    expect(g).toEqual([SFX_GAIN_FLOOR_DB]);
  });

  test('a cue with no file (unknown sfx name) keeps 0 dB', () => {
    const g = sfxCueGainsDb([{ atMs: 1000, sfx: 'nope' }], files, reader(noise(3, -30)));
    expect(g).toEqual([0]);
  });

  test('stacked cues: an earlier tail inside a later window counts, both windows hold the margin', () => {
    const long = new Map([['tap', burst(1.2, 0.9, 3)]]);
    const speech = noise(4, -22, 5);
    const cues = [
      { atMs: 1000, sfx: 'tap' },
      { atMs: 1150, sfx: 'tap' },
      { atMs: 1300, sfx: 'tap' },
    ];
    const g = sfxCueGainsDb(cues, long, reader(speech));
    for (const m of margins(cues, long, speech, g)) expect(m).toBeGreaterThanOrEqual(SFX_MARGIN_LU);
  });
});

describe('mix graph with cue gains', () => {
  function input(gains?: number[]): MixInput {
    const seq: Sequence = {
      ...emptySequence('seq_g', F30),
      audioTracks: [track('A1', [clip('it_a1', 'm_a', 0, 3000, 0)])],
      captions: { ...CAPTION_DEFAULTS, overrides: [] },
    };
    const cues: Cue[] = [
      { atMs: 500, sfx: 'pop', type: 'appear', itemId: 'it_s', cueName: 'in' },
      { atMs: 1500, sfx: 'pop', type: 'appear', itemId: 'it_s', cueName: 'out' },
    ];
    return {
      seq,
      media: [media('m_a', { loudness: { integratedLufs: -20, truePeakDb: -3 } })],
      projectDir: PROJECT_DIR,
      cues,
      sfxFiles: { pop: '/vox-test/sfx/pop.wav' },
      durationMs: 3000,
      preset: 'youtube',
      ...(gains ? { sfxGainsDb: gains } : {}),
    };
  }

  test('a cue gain is a volume filter on that cue only; 0 dB adds nothing', () => {
    const g = mixGraph(input([-12.5, 0]));
    const lines = g.filter.split(';\n');
    const pops = lines.filter((l) => l.includes('adelay=delays=24000S') || l.includes('72000S'));
    expect(pops).toHaveLength(2);
    expect(pops[0]).toContain('volume=-12.5dB,adelay=delays=24000S');
    expect(pops[1]).not.toContain('volume=');
  });

  test('without gains the graph is the same as before', () => {
    expect(mixGraph(input()).filter).toBe(mixGraph(input([0, 0])).filter);
  });
});
