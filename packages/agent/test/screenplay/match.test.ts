// Matching rules (14b step 3): one clip per scene, each clip once, the best take with a note.
import { describe, expect, test } from 'vitest';
import {
  assign,
  cosine,
  LOCAL_MARGIN,
  LOCAL_TOP_K,
  localScores,
  localShortlist,
  MATCH_MIN_LLM,
  rankLocal,
  wordOverlap,
  type Embedder,
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

describe('local first pass (D-77)', () => {
  // one-hot topics: scene i and clip c${i} share topic i; the "blur" clip is half of topics 0 and 1
  const topics = 12;
  const oneHot = (i: number) => Array.from({ length: topics }, (_, k) => (k === i ? 1 : 0));
  const textOf = (t: string) => Number(/topic(\d+)/.exec(t)?.[1] ?? -1);
  const embed: Embedder = (texts) =>
    Promise.resolve(
      texts.map((t) =>
        t.includes('blur')
          ? oneHot(0).map((x, k) => x + (k === 1 ? 1 : 0))
          : textOf(t) >= 0
            ? oneHot(textOf(t))
            : oneHot(topics - 1),
      ),
    );
  embed.local = true;
  const topicClip = (i: number): Footage => ({
    ...clip(`c${String(i)}`),
    description: `topic${String(i)}`,
  });

  test('a clear best clip is sure; scores on the LLM scale, only the best above the bar', async () => {
    const footage = [0, 1, 2, 3].map(topicClip);
    const [row] = await rankLocal(embed, [scene(1, 'topic2')], footage);
    expect(row!.sure).toBe(true);
    expect(row!.margin).toBeGreaterThanOrEqual(LOCAL_MARGIN);
    expect(row!.ranked[0]!.mediaId).toBe('c2');
    const scores = localScores(row!);
    expect(scores[0]).toEqual({ mediaId: 'c2', score: Math.min(1, MATCH_MIN_LLM + row!.margin) });
    expect(scores.slice(1).every((x) => x.score < MATCH_MIN_LLM)).toBe(true);
    const [a] = assign([scene(1, 'topic2')], [scores], MATCH_MIN_LLM, footage);
    expect(a!.mediaId).toBe('c2');
  });

  test('two near-equal clips: unsure (goes to the LLM)', async () => {
    const footage = [topicClip(0), { ...clip('dup'), description: 'topic0 again' }, topicClip(2)];
    const [row] = await rankLocal(embed, [scene(1, 'topic0')], footage);
    expect(row!.margin).toBeLessThan(LOCAL_MARGIN);
    expect(row!.sure).toBe(false);
  });

  test('fewer than 3 clips: never sure', async () => {
    const [row] = await rankLocal(embed, [scene(1, 'topic0')], [topicClip(0), topicClip(1)]);
    expect(row!.sure).toBe(false);
  });

  test('the LLM shortlist is the best LOCAL_TOP_K clips, in footage order', async () => {
    const footage = Array.from({ length: topics - 1 }, (_, i) => topicClip(i));
    footage.push({ ...clip('blur'), description: 'blur' });
    const [row] = await rankLocal(embed, [scene(1, 'topic0')], footage);
    const sent = localShortlist(row!, footage);
    expect(sent).toHaveLength(LOCAL_TOP_K);
    expect(sent.map((f) => f.mediaId)).toEqual(
      footage
        .filter((f) => row!.ranked.slice(0, LOCAL_TOP_K).some((x) => x.mediaId === f.mediaId))
        .map((f) => f.mediaId),
    );
    // the two best (the scene's own clip and the blur) are in it
    expect(sent.map((f) => f.mediaId)).toEqual(expect.arrayContaining(['c0', 'blur']));
  });

  test('the wrong number of vectors is an error', async () => {
    const bad: Embedder = () => Promise.resolve([[1]]);
    await expect(rankLocal(bad, [scene(1, 'a')], [clip('x')])).rejects.toThrow(/wrong number/);
  });
});
