import { describe, expect, test } from 'vitest';
import {
  captionsToSrt,
  captionsToVtt,
  deriveCaptions,
  type CaptionChunk,
} from '../../src/model/captions.ts';
import type {
  CaptionOverride,
  CaptionTrack,
  Item,
  MediaItem,
  Project,
  Transcript,
  TranscriptWord,
} from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { baseProject, emptySequence, videoMedia } from '../helpers/project.ts';

type W = [text: string, startMs: number, endMs: number, kind?: TranscriptWord['kind']];
const words = (ws: W[]): TranscriptWord[] =>
  ws.map(([text, startMs, endMs, kind = 'word']) => ({ text, startMs, endMs, kind }));

interface Clip {
  id?: string;
  track?: 'A1' | 'A2';
  media?: string;
  startMs: number;
  inMs: number;
  durationMs: number;
}

function project(
  transcripts: Record<string, Transcript>,
  clips: Clip[],
  cap: Partial<CaptionTrack> = {},
): { p: Project; tOf: (m: MediaItem) => Transcript | undefined } {
  const seq = emptySequence();
  clips.forEach((c, i) => {
    const t = seq.audioTracks.find((x) => x.id === (c.track ?? 'A1'))!;
    const item: Item = {
      id: c.id ?? `it_c${i}`,
      type: 'media',
      mediaId: c.media ?? 'm_a',
      startMs: c.startMs,
      inMs: c.inMs,
      durationMs: c.durationMs,
    };
    t.items.push(item);
  });
  seq.captions = { ...CAPTION_DEFAULTS, overrides: [], maxWords: 3, maxCharsPerLine: 40, ...cap };
  const media = Object.keys(transcripts).map((id) =>
    videoMedia(id, { transcriptRev: 'r1', fps: { num: 30, den: 1 }, durationMs: 60000 }),
  );
  const p = baseProject(seq, media);
  return { p, tOf: (m) => transcripts[m.id] };
}

const tr = (ws: W[], language = 'en'): Transcript => ({
  language,
  words: words(ws),
  speechRegions: [],
});
const derive = (x: ReturnType<typeof project>) => deriveCaptions(x.p, 'seq_1', x.tOf);
const texts = (cs: CaptionChunk[]) =>
  cs.map((c) => c.lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' / '));
const flat = (cs: CaptionChunk[]) => cs.flatMap((c) => c.lines.flatMap((l) => l.words));
const ov = (i: number, o: Omit<CaptionOverride, 'wordKey'>): CaptionOverride => ({
  wordKey: `m_a:r1:${i}`,
  ...o,
});

describe('deriveCaptions', () => {
  test('empty without a caption track', () => {
    const x = project({ m_a: tr([['a', 0, 100]]) }, [{ startMs: 0, inMs: 0, durationMs: 1000 }]);
    x.p.sequences[0]!.captions = null;
    expect(derive(x)).toEqual([]);
  });

  test('midpoint rule, shift and clamp to the clip', () => {
    // clip shows source 1000..2000 at timeline 5000
    const x = project(
      {
        m_a: tr([
          ['before', 700, 1100], // midpoint 900: out
          ['edge', 900, 1300], // midpoint 1100: in, clamped to the clip start
          ['mid', 1400, 1600],
          ['tail', 1900, 2300], // midpoint 2100: out
        ]),
      },
      [{ startMs: 5000, inMs: 1000, durationMs: 1000 }],
    );
    const w = flat(derive(x));
    expect(w.map((v) => v.text)).toEqual(['edge', 'mid']);
    expect(w[0]!.startMs).toBe(5000);
    expect(w[1]!.startMs).toBe(5400);
    expect(w.map((v) => v.key)).toEqual(['m_a:r1:1', 'm_a:r1:2']);
  });

  test('zero-length words get one frame; times sit on the frame grid', () => {
    const x = project(
      {
        m_a: tr([
          ['pop', 500, 500],
          ['odd', 1010, 1490],
        ]),
      },
      [{ startMs: 0, inMs: 0, durationMs: 3000 }],
    );
    const w = flat(derive(x));
    expect(w[0]!.startMs).toBe(500);
    expect(w[0]!.endMs).toBeGreaterThan(500);
    expect(w[1]!.startMs).toBe(1000);
    expect(w[1]!.endMs).toBe(1500);
  });

  test('overlapping words are trimmed to the next start', () => {
    const x = project(
      {
        m_a: tr([
          ['one', 0, 600],
          ['two', 400, 800],
        ]),
      },
      [{ startMs: 0, inMs: 0, durationMs: 3000 }],
    );
    const w = flat(derive(x));
    expect(w[0]!.endMs).toBe(400);
  });

  test('no pause pseudo-words; fillers and repeats stay', () => {
    const x = project(
      {
        m_a: tr([
          ['um', 0, 200, 'filler'],
          ['', 200, 600, 'pause'],
          ['so', 600, 700, 'repeat'],
          ['so', 700, 800],
        ]),
      },
      [{ startMs: 0, inMs: 0, durationMs: 3000 }],
      { maxWords: 10 },
    );
    expect(flat(derive(x)).map((w) => w.text)).toEqual(['um', 'so', 'so']);
  });

  test('chunking: maxWords, pauses over 300 ms, clip boundaries, breakAfter', () => {
    const ws: W[] = [
      ['a', 0, 100],
      ['b', 100, 200],
      ['c', 200, 300],
      ['d', 300, 400], // maxWords 3 → new chunk
      ['e', 750, 850], // 350 ms pause → new chunk
      ['f', 850, 950],
      ['g', 1250, 1350], // exactly 300 ms → same chunk
    ];
    const x = project({ m_a: tr(ws) }, [
      { id: 'it_x', startMs: 0, inMs: 0, durationMs: 1400 },
      { id: 'it_y', startMs: 1400, inMs: 0, durationMs: 300 }, // a second clip: 'a','b','c' again
    ]);
    expect(texts(derive(x))).toEqual(['a b c', 'd', 'e f g', 'a b c']);
    x.p.sequences[0]!.captions!.overrides = [ov(0, { breakAfter: true })];
    expect(texts(derive(x))).toEqual(['a', 'b c d', 'e f g', 'a', 'b c']);
  });

  test('overrides by wordKey: text, multi-word text, hidden word, retime', () => {
    const x = project(
      {
        m_a: tr([
          ['hello', 0, 300],
          ['wrld', 300, 900],
          ['uh', 900, 1000, 'filler'],
          ['late', 1000, 1100],
        ]),
      },
      [{ startMs: 0, inMs: 0, durationMs: 5000 }],
      { maxWords: 10 },
    );
    x.p.sequences[0]!.captions!.overrides = [
      ov(1, { text: 'big wide world' }),
      ov(2, { text: null }),
      ov(3, { startMs: 1500, endMs: 1600 }),
    ];
    const w = flat(derive(x));
    expect(w.map((v) => v.text)).toEqual(['hello', 'big', 'wide', 'world', 'late']);
    // 600 ms split evenly in three on the 30 fps grid
    expect(w.slice(1, 4).map((v) => [v.startMs, v.key])).toEqual([
      [300, 'm_a:r1:1'],
      [500, 'm_a:r1:1'],
      [700, 'm_a:r1:1'],
    ]);
    expect(w[4]!.startMs).toBe(1500);
    // retimed word is chunked by its new time: the gap 900 → 1500 starts a new chunk
    expect(texts(derive(x))).toEqual(['hello big wide world', 'late'].map((t) => t));
  });

  test('multi-word text counts as separate words for chunking', () => {
    const x = project(
      {
        m_a: tr([
          ['x', 0, 600],
          ['y', 600, 700],
        ]),
      },
      [{ startMs: 0, inMs: 0, durationMs: 2000 }],
    );
    x.p.sequences[0]!.captions!.overrides = [ov(0, { text: 'one two three' })];
    expect(texts(derive(x))).toEqual(['one two three', 'y']);
  });

  test('orphaned overrides (re-transcription) are ignored', () => {
    const x = project({ m_a: tr([['a', 0, 100]]) }, [{ startMs: 0, inMs: 0, durationMs: 1000 }]);
    x.p.sequences[0]!.captions!.overrides = [
      { wordKey: 'm_a:r0:0', text: 'stale' },
      { wordKey: 'm_a:r0:0', breakAfter: true },
    ];
    expect(flat(derive(x)).map((w) => w.text)).toEqual(['a']);
  });

  test('lower track index wins where source tracks overlap', () => {
    const x = project(
      {
        m_a: tr([
          ['one', 0, 400],
          ['two', 1200, 1400],
        ]),
        m_b: tr([
          ['other', 0, 400],
          ['alone', 2600, 2800],
        ]),
      },
      [
        { track: 'A1', media: 'm_a', startMs: 0, inMs: 0, durationMs: 2000 },
        { track: 'A2', media: 'm_b', startMs: 0, inMs: 0, durationMs: 3000 },
      ],
      { sourceTrackIds: ['A2', 'A1'], maxWords: 10 },
    );
    expect(flat(derive(x)).map((w) => w.text)).toEqual(['one', 'two', 'alone']);
  });

  test('no-space languages chunk by characters (maxWords × 4)', () => {
    const ws: W[] = ['今日', 'は', 'いい', '天気', 'です', 'ね'].map((t, i) => [
      t,
      i * 200,
      i * 200 + 200,
    ]);
    const x = project({ m_a: tr(ws, 'ja') }, [{ startMs: 0, inMs: 0, durationMs: 2000 }], {
      maxWords: 2,
    });
    // 8 characters per chunk
    expect(
      derive(x).map((c) => c.lines.flatMap((l) => l.words.map((w) => w.text)).join('')),
    ).toEqual(['今日はいい天気', 'ですね']);
  });

  test('lines by maxCharsPerLine and maxLines; a longer word gets its own line', () => {
    const ws: W[] = ['the', 'quick', 'brown', 'extraordinarily', 'fox', 'ran'].map((t, i) => [
      t,
      i * 200,
      i * 200 + 200,
    ]);
    const x = project({ m_a: tr(ws) }, [{ startMs: 0, inMs: 0, durationMs: 3000 }], {
      maxWords: 10,
      maxCharsPerLine: 10,
      maxLines: 2,
    });
    const cs = derive(x);
    expect(cs.map((c) => c.lines.map((l) => l.words.map((w) => w.text).join(' ')))).toEqual([
      ['the quick', 'brown'],
      ['extraordinarily', 'fox ran'],
    ]);
  });

  test('gap fill: 300 ms gap filled, 500 ms not (gapFillMs 400)', () => {
    const ws: W[] = [
      ['a', 0, 200],
      ['b', 500, 700], // maxWords 1: each word its own chunk; gap 300
      ['c', 1200, 1400], // gap 500 (also a pause: still a new chunk)
    ];
    const x = project({ m_a: tr(ws) }, [{ startMs: 0, inMs: 0, durationMs: 3000 }], {
      maxWords: 1,
      gapFillMs: 400,
    });
    const cs = derive(x);
    expect(cs.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 500],
      [500, 700],
      [1200, 1400],
    ]);
  });

  test('word ends extend to the next word inside a chunk', () => {
    const x = project(
      {
        m_a: tr([
          ['a', 0, 100],
          ['b', 300, 400],
          ['c', 500, 600],
        ]),
      },
      [{ startMs: 0, inMs: 0, durationMs: 3000 }],
    );
    const w = flat(derive(x));
    expect(w.map((v) => [v.startMs, v.endMs])).toEqual([
      [0, 300],
      [300, 500],
      [500, 600],
    ]);
  });

  test('emphasis: autoEmphasis numbers and capitalised non-initial words; override wins', () => {
    const ws: W[] = [
      ['Ships', 0, 100], // sentence start: no
      ['left', 100, 200],
      ['Lisbon', 200, 300], // yes
      ['in', 300, 400],
      ['1498.', 400, 500], // number
      ['Then', 500, 600], // after a full stop: no
      ['they', 600, 700],
    ];
    const x = project({ m_a: tr(ws) }, [{ startMs: 0, inMs: 0, durationMs: 3000 }], {
      maxWords: 10,
      autoEmphasis: true,
    });
    const em = () =>
      flat(derive(x))
        .filter((w) => w.emphasis)
        .map((w) => w.text);
    expect(em()).toEqual(['Lisbon', '1498.']);
    x.p.sequences[0]!.captions!.overrides = [ov(2, { emphasis: false }), ov(6, { emphasis: true })];
    expect(em()).toEqual(['1498.', 'they']);
    x.p.sequences[0]!.captions!.autoEmphasis = false;
    expect(em()).toEqual(['they']);
  });
});

describe('SRT / VTT', () => {
  const chunks: CaptionChunk[] = [
    {
      startMs: 0,
      endMs: 1500,
      lines: [
        { words: [{ key: 'm_a:r1:0', text: 'Hello,', startMs: 0, endMs: 500, emphasis: false }] },
        { words: [{ key: 'm_a:r1:1', text: 'world!', startMs: 500, endMs: 1500, emphasis: true }] },
      ],
    },
    {
      startMs: 3_723_004,
      endMs: 3_724_000,
      lines: [
        {
          words: [
            { key: 'm_a:r1:2', text: 'a<b', startMs: 3_723_004, endMs: 3_723_500, emphasis: false },
            { key: 'm_a:r1:3', text: 'c', startMs: 3_723_500, endMs: 3_724_000, emphasis: false },
          ],
        },
      ],
    },
  ];
  test('one cue per chunk, one text line per chunk line, text as is', () => {
    expect(captionsToSrt(chunks)).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nHello,\nworld!\n\n2\n01:02:03,004 --> 01:02:04,000\na<b c\n',
    );
    expect(captionsToVtt(chunks)).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello,\nworld!\n\n01:02:03.004 --> 01:02:04.000\na&lt;b c\n',
    );
  });
});
