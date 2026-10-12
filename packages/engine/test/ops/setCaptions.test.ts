import { describe, expect, test } from 'vitest';
import { ap, expectCode, seq, testCtx } from '../helpers/ops.ts';
import { templates } from '../helpers/templates.ts';
import { baseProject, richProject } from '../helpers/project.ts';

const set = (args: Record<string, unknown>, p = richProject()) =>
  ap(p, 'setCaptions', { sequenceId: 'seq_1', ...args });
const caps = (p: ReturnType<typeof richProject>) => seq(p).captions!;
const ov = (p: ReturnType<typeof richProject>, key: string) =>
  caps(p).overrides.find((o) => o.wordKey === key);

describe('setCaptions', () => {
  test('the first call creates the track with the defaults (6a)', () => {
    const p = set({}, baseProject());
    expect(caps(p)).toEqual({
      enabled: true,
      sourceTrackIds: ['A1'],
      preset: 'base/plain',
      maxWords: 3,
      maxLines: 1,
      maxCharsPerLine: 18,
      gapFillMs: 400,
      autoEmphasis: false,
      position: { yPct: 75 },
      overrides: [],
    });
  });
  test('track fields update', () => {
    const p = set({
      enabled: false,
      sourceTrackIds: ['A2'],
      preset: 'vox/bold',
      maxWords: 5,
      maxLines: 2,
      maxCharsPerLine: 24,
      gapFillMs: 0,
      autoEmphasis: true,
      position: { yPct: 60 },
    });
    expect(caps(p)).toMatchObject({
      enabled: false,
      sourceTrackIds: ['A2'],
      preset: 'vox/bold',
      maxWords: 5,
      maxLines: 2,
      maxCharsPerLine: 24,
      gapFillMs: 0,
      autoEmphasis: true,
      position: { yPct: 60 },
    });
  });
  test('a new preset brings its position and track settings; given fields win (D-93)', () => {
    const ctx = testCtx({
      templates: {
        get: (id) => templates.get(id),
        captionPreset: (id) =>
          id === 'x/two-tier'
            ? {
                position: { yPct: 50 },
                track: { maxWords: 5, maxLines: 2, maxCharsPerLine: 26, autoEmphasis: true },
                tiered: true,
              }
            : id === 'x/plain'
              ? { position: { yPct: 80 } }
              : undefined,
      },
    });
    const p = ap(baseProject(), 'setCaptions', { sequenceId: 'seq_1', preset: 'x/two-tier' }, ctx);
    expect(caps(p)).toMatchObject({
      preset: 'x/two-tier',
      position: { yPct: 50 },
      maxWords: 5,
      maxLines: 2,
      maxCharsPerLine: 26,
      autoEmphasis: true,
    });
    // the same preset again leaves the user's own settings alone
    const moved = ap(p, 'setCaptions', { sequenceId: 'seq_1', position: { yPct: 30 } }, ctx);
    const again = ap(moved, 'setCaptions', { sequenceId: 'seq_1', preset: 'x/two-tier' }, ctx);
    expect(caps(again).position).toEqual({ yPct: 30 });
    // a preset without track settings changes only the position
    const plain = ap(again, 'setCaptions', { sequenceId: 'seq_1', preset: 'x/plain' }, ctx);
    expect(caps(plain)).toMatchObject({ position: { yPct: 80 }, maxWords: 5, maxLines: 2 });
    // fields in the same call win
    const own = ap(
      baseProject(),
      'setCaptions',
      { sequenceId: 'seq_1', preset: 'x/two-tier', position: { yPct: 65 }, maxWords: 3 },
      ctx,
    );
    expect(caps(own)).toMatchObject({ position: { yPct: 65 }, maxWords: 3, maxLines: 2 });
    // an unknown preset (or a lookup without presets) keeps the sequence's settings
    const unknown = ap(baseProject(), 'setCaptions', { sequenceId: 'seq_1', preset: 'x/none' }, ctx);
    expect(caps(unknown)).toMatchObject({ position: { yPct: 75 }, maxWords: 3 });
  });
  test('source tracks must be audio tracks of the sequence', () => {
    expectCode(() => set({ sourceTrackIds: ['A9'] }), 'NOT_FOUND');
    expectCode(() => set({ sourceTrackIds: ['V1'] }), 'VALIDATION');
  });
  test('override text (several words) and text: null', () => {
    let p = set({ overrides: [{ wordKey: 'm_video:r1:5', text: 'two words' }] });
    expect(ov(p, 'm_video:r1:5')).toEqual({ wordKey: 'm_video:r1:5', text: 'two words' });
    p = set({ overrides: [{ wordKey: 'm_video:r1:5', text: null }] }, p);
    expect(ov(p, 'm_video:r1:5')!.text).toBeNull();
  });
  test('override breakAfter', () => {
    expect(
      ov(set({ overrides: [{ wordKey: 'm_video:r1:4', breakAfter: true }] }), 'm_video:r1:4')!
        .breakAfter,
    ).toBe(true);
  });
  test('override emphasis (D-15)', () => {
    expect(
      ov(set({ overrides: [{ wordKey: 'm_video:r1:4', emphasis: false }] }), 'm_video:r1:4')!
        .emphasis,
    ).toBe(false);
  });
  test('override startMs/endMs: start < end, both inside the media', () => {
    expect(
      ov(
        set({ overrides: [{ wordKey: 'm_video:r1:4', startMs: 100, endMs: 300 }] }),
        'm_video:r1:4',
      ),
    ).toMatchObject({ startMs: 100, endMs: 300 });
    expectCode(
      () => set({ overrides: [{ wordKey: 'm_video:r1:4', startMs: 300, endMs: 300 }] }),
      'VALIDATION',
    );
    expectCode(
      () => set({ overrides: [{ wordKey: 'm_video:r1:4', startMs: 100, endMs: 20001 }] }),
      'VALIDATION',
    );
    // merged with an existing endMs
    const p = set({ overrides: [{ wordKey: 'm_video:r1:4', endMs: 300 }] });
    expectCode(
      () => set({ overrides: [{ wordKey: 'm_video:r1:4', startMs: 400 }] }, p),
      'VALIDATION',
    );
  });
  test('overrides upsert by wordKey and merge fields; sorted by wordKey', () => {
    const p = set({
      overrides: [
        { wordKey: 'm_video:r1:2', emphasis: true },
        { wordKey: 'm_video:r1:10', breakAfter: true },
      ],
    });
    expect(ov(p, 'm_video:r1:2')).toEqual({
      wordKey: 'm_video:r1:2',
      text: 'Hi there',
      emphasis: true,
    });
    expect(caps(p).overrides.map((o) => o.wordKey)).toEqual([
      'm_video:r1:0',
      'm_video:r1:2',
      'm_video:r1:10',
    ]);
  });
  test('resetWords removes overrides (resets the word)', () => {
    const p = set({ resetWords: ['m_video:r1:2'] });
    expect(ov(p, 'm_video:r1:2')).toBeUndefined();
    expect(ov(p, 'm_video:r1:0')).toBeDefined();
  });
  test('a wordKey of an old transcriptRev is rejected; orphans are dropped', () => {
    expectCode(() => set({ overrides: [{ wordKey: 'm_video:r0:1', text: 'x' }] }), 'VALIDATION');
    const p0 = ap(richProject(), 'updateMedia', {
      mediaId: 'm_video',
      patch: { transcriptRev: 'r2' },
    });
    const p = set({ maxWords: 4 }, p0);
    expect(caps(p).overrides).toEqual([]);
  });
});
