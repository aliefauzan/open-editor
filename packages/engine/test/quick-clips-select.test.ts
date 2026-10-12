// Quick clips selection rules on crafted inputs (phase 05 step 12b; engine spec "Quick clips", plan
// D-15): sentence units, the 120 ms lead-in that never cuts into the previous word, the move to a shot
// cut within 2 frames, edge pauses trimmed, each new heuristic signal (energy, hook, coverage and the
// D-75 video highlights) changing the pick when everything else is equal, and the shortlist a
// registered scorer gets.
import { describe, expect, test } from 'vitest';
import type { Transcript, TranscriptWord } from '../src/model/schema.ts';
import type { Detections } from '../src/stages/facetrack.ts';
import type { Highlights } from '../src/stages/highlights.ts';
import {
  HIGHLIGHT_WEIGHT,
  clipStart,
  heuristicScores,
  highlightLevel,
  pickClips,
  quickCandidates,
  scorerShortlist,
  sentenceUnits,
  type Candidate,
} from '../src/stages/quickClips.ts';

const F30 = { num: 30, den: 1 };
const w = (text: string, startMs: number, endMs: number): TranscriptWord => ({
  text,
  startMs,
  endMs,
  kind: 'word',
});
const pause = (startMs: number, endMs: number): TranscriptWord => ({
  text: '',
  startMs,
  endMs,
  kind: 'pause',
});

describe('sentence units and boundaries', () => {
  test('units end at sentence punctuation or at a pause of 700 ms or more', () => {
    const words = [
      w('One', 0, 200),
      w('two.', 250, 500),
      w('Three', 600, 800),
      pause(800, 1500),
      w('four', 1500, 1700),
      w('five?', 1750, 2000),
    ];
    expect(sentenceUnits(words).map((u) => [u.text, u.startMs, u.endMs])).toEqual([
      ['One two.', 0, 500],
      ['Three', 600, 800],
      ['four five?', 1500, 2000],
    ]);
  });

  test('120 ms lead-in, never inside the previous word, never before 0', () => {
    const words = [w('Hi.', 0, 900), w('Next', 1000, 1300), w('one.', 1350, 1600)];
    const [first, second] = sentenceUnits(words);
    expect(clipStart(words, first!, [], F30)).toBe(0);
    expect(clipStart(words, second!, [], F30)).toBe(900); // 1000 - 120 = 880 is inside "Hi."
    const spaced = [w('Hi.', 0, 500), w('Next.', 1000, 1300)];
    expect(clipStart(spaced, sentenceUnits(spaced)[1]!, [], F30)).toBe(880);
  });

  test('a start within 2 frames before a shot cut moves to the cut', () => {
    const words = [w('Hi.', 0, 500), w('Next.', 1000, 1300)];
    const u = sentenceUnits(words)[1]!;
    expect(clipStart(words, u, [940], F30)).toBe(940); // 60 ms after 880 (≤ 66.7)
    expect(clipStart(words, u, [950], F30)).toBe(880); // 70 ms: more than 2 frames
    expect(clipStart(words, u, [870], F30)).toBe(880); // a cut before the start does not move it
  });

  test('edge pauses are trimmed: a clip ends at its last word', () => {
    const t: Transcript = {
      language: 'en',
      words: [
        w('Hello', 200, 600),
        w('there.', 650, 1000),
        pause(1000, 3000),
        w('Bye.', 3000, 3400),
      ],
      speechRegions: [
        { startMs: 200, endMs: 1000 },
        { startMs: 3000, endMs: 3400 },
      ],
    };
    const c = quickCandidates(t, { minMs: 500, maxMs: 1500, sourceFps: F30 });
    expect(c.map((x) => [x.startMs, x.endMs])).toEqual([
      [80, 1000],
      [2880, 3400],
    ]);
  });
});

// Two crafted candidates with the same speech signal; only one signal differs at a time.
function twoCandidates(firstA: string, firstB: string): { t: Transcript; cands: Candidate[] } {
  const words = [w(firstA, 1000, 2000), w(firstB, 11000, 12000)];
  const t: Transcript = {
    language: 'en',
    words,
    speechRegions: [
      { startMs: 1000, endMs: 2000 },
      { startMs: 11000, endMs: 12000 },
    ],
  };
  return { t, cands: quickCandidates(t, { minMs: 900, maxMs: 1500, sourceFps: F30 }) };
}

describe('heuristic signals (D-15)', () => {
  test('ties go to the earlier start', () => {
    const { t, cands } = twoCandidates('Plain words.', 'Plain words.');
    const { scores } = heuristicScores(cands, t);
    expect(scores[0]).toBe(scores[1]);
    expect(pickClips(cands, scores, 1)).toEqual([0]);
  });

  test('energy: the candidate with more loudness variance wins', () => {
    const { t, cands } = twoCandidates('Plain words.', 'Plain words.');
    const peaks = new Array<number>(1300).fill(0.3);
    for (let i = 1100; i < 1200; i++) peaks[i] = i % 20 < 10 ? 0.9 : 0.02; // B swings loud/quiet
    const { scores, signals } = heuristicScores(cands, t, {
      peaks: { peaksPerSecond: 100, peaks },
    });
    expect(signals.map((s) => s.energy)).toEqual([0, 1]);
    expect(pickClips(cands, scores, 1)).toEqual([1]);
  });

  test('hook: a question or a number in the first sentence wins', () => {
    for (const hook of ['Why does this work?', 'We saved 40 hours.', 'Three things matter.']) {
      const { t, cands } = twoCandidates('Plain words.', hook);
      const { scores, signals } = heuristicScores(cands, t);
      expect(
        signals.map((s) => s.hook),
        hook,
      ).toEqual([0, 1]);
      expect(pickClips(cands, scores, 1)).toEqual([1]);
    }
  });

  test('coverage: the candidate with a face on screen wins', () => {
    const { t, cands } = twoCandidates('Plain words.', 'Plain words.');
    const face = { x: 0.4, y: 0.2, w: 0.2, h: 0.3, score: 0.9 };
    const detections: Detections = {
      sampleFps: 10,
      width: 640,
      height: 360,
      durationMs: 13000,
      faceModel: { name: 'test', sha256: '0'.repeat(64) },
      samples: Array.from({ length: 130 }, (_, i) => ({
        atMs: i * 100,
        faces: i >= 110 ? [face] : [],
        bodies: [],
        saliency: null,
      })),
    };
    const { scores, signals } = heuristicScores(cands, t, { detections });
    expect(signals[0]!.coverage).toBe(0);
    expect(signals[1]!.coverage).toBeGreaterThan(0.9);
    expect(pickClips(cands, scores, 1)).toEqual([1]);
  });

  test('speech: an internal pause over 1.5 s costs 0.5', () => {
    const t: Transcript = {
      language: 'en',
      words: [w('A', 0, 500), w('b.', 2100, 2500), w('C', 10000, 10500), w('d.', 10600, 12500)],
      speechRegions: [
        { startMs: 0, endMs: 500 },
        { startMs: 2100, endMs: 2500 },
        { startMs: 10000, endMs: 12500 },
      ],
    };
    const cands = quickCandidates(t, { minMs: 2000, maxMs: 3000, sourceFps: F30 });
    const { signals } = heuristicScores(cands, t);
    expect(cands.map((c) => c.startMs)).toEqual([0, 9880]);
    expect(signals[0]!.speech).toBeCloseTo(900 / 2500 - 0.5, 5);
    expect(signals[1]!.speech).toBeCloseTo(2500 / 2620, 5);
  });
});

describe('video highlights (D-75)', () => {
  const steps = (from: number, to: number, level: (atMs: number) => number) =>
    Array.from({ length: (to - from) / 500 }, (_, k) => ({
      startMs: from + k * 500,
      endMs: from + (k + 1) * 500,
      level: level(from + k * 500),
    }));

  test('highlightLevel: mean level ÷ the top level, plus the share inside highlight ranges', () => {
    const h: Highlights = {
      highlights: [],
      levels: [
        { startMs: 0, endMs: 500, level: 2 },
        { startMs: 500, endMs: 1000, level: 8 },
      ],
      keyFrameMs: null,
    };
    expect(highlightLevel(h, 0, 1000)).toBe(5 / 8);
    expect(highlightLevel(h, 250, 750)).toBe(5 / 8);
    expect(highlightLevel(h, 500, 1000)).toBe(1);
    expect(highlightLevel(h, 2000, 3000)).toBe(0);
    const ranges: Highlights = {
      highlights: [{ startMs: 500, endMs: 1500 }],
      levels: [],
      keyFrameMs: null,
    };
    expect(highlightLevel(ranges, 0, 1000)).toBe(0.5);
    expect(highlightLevel(ranges, 600, 1400)).toBe(1);
    expect(highlightLevel({ ...h, highlights: ranges.highlights }, 500, 1000)).toBe(2);
  });

  test('without highlights the scores are the ones before D-75; with them the higher level wins', () => {
    const { t, cands } = twoCandidates('Plain words.', 'Plain words.');
    const plain = heuristicScores(cands, t);
    expect(plain.signals.map((s) => s.highlight)).toEqual([0, 0]);
    expect(plain.scores.map((x, i) => x - plain.signals[i]!.speech)).toEqual([0, 0]);
    expect(pickClips(cands, plain.scores, 1)).toEqual([0]);
    // the later candidate (B, about 11–12 s) sits in the high-level part of the video
    const highlights: Highlights = {
      highlights: [{ startMs: 10500, endMs: 12500 }],
      levels: steps(0, 13000, (at) => (at >= 10500 ? 9 : 3)),
      keyFrameMs: 11000,
    };
    const { scores, signals } = heuristicScores(cands, t, { highlights });
    expect(signals.map((s) => s.highlight)).toEqual([0, 1]);
    expect(scores[1]! - scores[0]!).toBeCloseTo(HIGHLIGHT_WEIGHT, 5);
    expect(pickClips(cands, scores, 1)).toEqual([1]);
  });

  test('the highlight signal adds to the others, it does not replace them', () => {
    // A has a hook (+1), B a slightly higher level (+1 after scaling): a tie, broken by the start
    const { t, cands } = twoCandidates('Why does this work?', 'Plain words.');
    const highlights: Highlights = {
      highlights: [],
      levels: steps(0, 13000, (at) => (at >= 10500 ? 7 : 6)),
      keyFrameMs: null,
    };
    const { scores, signals } = heuristicScores(cands, t, { highlights });
    expect(signals.map((s) => [s.hook, s.highlight])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(scores[0]).toBeCloseTo(scores[1]!, 5);
    expect(pickClips(cands, scores, 1)).toEqual([0]);
  });
});

describe('scorer shortlist and pick limits (D-75)', () => {
  const cand = (startMs: number, endMs: number): Candidate => ({
    startMs,
    endMs,
    text: '',
    firstSentence: '',
    firstUnit: 0,
    lastUnit: 0,
  });

  test('the best `cap` by score, in candidate order; all of them when there are no more', () => {
    const cands = [cand(0, 10), cand(10, 20), cand(20, 30), cand(30, 40), cand(40, 50)];
    const scores = [1, 5, 2, 4, 3];
    expect(scorerShortlist(cands, scores, 3)).toEqual([1, 3, 4]);
    expect(scorerShortlist(cands, scores, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(scorerShortlist(cands, scores, 9)).toEqual([0, 1, 2, 3, 4]);
    // ties: the earlier start first
    expect(scorerShortlist(cands, [1, 1, 1, 1, 1], 2)).toEqual([0, 1]);
  });

  test('pickClips: `among` limits the pick, `taken` picks stay and block overlaps', () => {
    const cands = [cand(0, 10), cand(5, 15), cand(20, 30), cand(25, 35)];
    const scores = [1, 9, 2, 8];
    expect(pickClips(cands, scores, 2)).toEqual([1, 3]);
    expect(pickClips(cands, scores, 2, { among: [0, 2] })).toEqual([2, 0]);
    expect(pickClips(cands, scores, 3, { among: [0, 2, 3], taken: [1] })).toEqual([1, 3]);
  });
});
