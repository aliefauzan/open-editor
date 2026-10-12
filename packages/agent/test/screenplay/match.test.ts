// Matching rules (14b step 3): one clip per scene, each clip once, the best take with a note.
import { describe, expect, test } from 'vitest';
import {
  assign,
  cosine,
  wordOverlap,
  type Footage,
  type Ranked,
} from '../../src/screenplay/match.ts';
import type { Scene } from '../../src/screenplay/parse.ts';

const scene = (index: number, heading: string, description = '', estimatedMs = 3000): Scene => ({
  index,
  heading,
  description,
  dialogue: [],
  estimatedMs,
});
const clip = (mediaId: string, durationMs = 3000, tags: string[] = []): Footage => ({
  mediaId,
  label: `${mediaId}.mp4`,
  tags,
  description: '',
  durationMs,
});
const r = (mediaId: string, score: number): Ranked => ({ mediaId, score });

describe('assign', () => {
  test('a clip two scenes want goes to the scene it fits better; the other takes its next match', () => {
    const out = assign(
      [scene(1, 'A'), scene(2, 'B')],
      [
        [r('m1', 0.9), r('m2', 0.6)],
        [r('m1', 0.95), r('m2', 0.1)],
      ],
      0.5,
      [clip('m1'), clip('m2')],
    );
    expect(out.map((a) => a.mediaId)).toEqual(['m2', 'm1']);
  });

  test('below the bar: no clip (placeholder); the bar is per scene', () => {
    const out = assign(
      [scene(1, 'A'), scene(2, 'B')],
      [[r('m1', 0.4)], [r('m1', 0.4)]],
      [0.5, 0.3],
      [clip('m1')],
    );
    expect(out[0]!.mediaId).toBeUndefined();
    expect(out[1]!.mediaId).toBe('m1');
  });

  test('several matches: best take by score, then by length closest to the scene, then id; a note', () => {
    const out = assign(
      [scene(1, 'A', '', 4000)],
      [[r('m2', 0.9), r('m1', 0.9), r('m3', 0.7)]],
      0.5,
      [clip('m1', 9000), clip('m2', 4100), clip('m3')],
    );
    expect(out[0]!.mediaId).toBe('m2');
    expect(out[0]!.alternatives.map((a) => a.mediaId)).toEqual(['m1', 'm3']);
    expect(out[0]!.note).toMatch(
      /Scene 1 had 3 matching clips: used m2\.mp4 \(best take, score 0\.90\); also matched: m1\.mp4 0\.90, m3\.mp4 0\.70/,
    );
  });

  test('a clip another scene took is not named as an alternative', () => {
    const out = assign(
      [scene(1, 'A'), scene(2, 'B')],
      [[r('m1', 0.9), r('m2', 0.8)], [r('m2', 0.95)]],
      0.5,
      [clip('m1'), clip('m2')],
    );
    expect(out[0]!.mediaId).toBe('m1');
    expect(out[0]!.note).toBeUndefined();
  });
});

describe('scores', () => {
  test('cosine', () => {
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
  test('word overlap: the share of the clip words found in the scene', () => {
    const s = scene(1, 'INT. KITCHEN - NIGHT', 'Mara pours tea beside the window.');
    expect(wordOverlap(s, { ...clip('m1', 3000, ['kitchen', 'tea', 'window']) })).toBeGreaterThan(
      0.5,
    );
    expect(wordOverlap(s, { ...clip('m2', 3000, ['harbor', 'boat', 'gulls']) })).toBe(0);
  });
});
