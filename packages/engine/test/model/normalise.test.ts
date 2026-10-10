import { describe, expect, test } from 'vitest';
import { canonical, denormalise, normalise, projectFrame } from '../../src/model/normalise.ts';
import { richProject } from '../helpers/project.ts';

describe('normalise / denormalise', () => {
  test('entity keys follow the History table', () => {
    const keys = [...normalise(richProject()).keys()].sort();
    expect(keys).toEqual(
      [
        'project',
        'media:m_video',
        'media:m_img',
        'media:m_aud',
        'sequence:seq_1',
        'track:seq_1/V1',
        'track:seq_1/V2',
        'track:seq_1/A1',
        'track:seq_1/A2',
        'item:seq_1/it_v1',
        'item:seq_1/it_v2',
        'item:seq_1/it_s1',
        'item:seq_1/it_a1',
        'item:seq_1/it_a2',
        'captions:seq_1',
        'captionOverride:seq_1/m_video:r1:0',
        'captionOverride:seq_1/m_video:r1:2',
      ].sort(),
    );
  });

  test('entities hold their own fields only', () => {
    const m = normalise(richProject());
    expect(m.get('sequence:seq_1')).toMatchObject({
      videoTrackIds: ['V1', 'V2'],
      audioTrackIds: ['A1', 'A2'],
    });
    expect(m.get('sequence:seq_1')).not.toHaveProperty('videoTracks');
    expect(m.get('track:seq_1/V1')).not.toHaveProperty('items');
    expect(m.get('item:seq_1/it_a1')).toMatchObject({ trackId: 'A1', mediaId: 'm_video' });
    expect(m.get('captions:seq_1')).not.toHaveProperty('overrides');
    expect(m.get('captionOverride:seq_1/m_video:r1:2')).toEqual({
      wordKey: 'm_video:r1:2',
      text: 'Hi there',
    });
    // project entity: no version, no updatedAt (D-18)
    expect(m.get('project')).toEqual({
      id: 'p_test',
      name: 'test',
      meta: { createdAt: '2026-10-11T00:00:00.000Z', sourceUrls: [] },
    });
  });

  test('round trip returns the canonical project (items by startMs, overrides by wordKey)', () => {
    const p = richProject();
    const back = denormalise(normalise(p), projectFrame(p));
    // only the order of media (by id) and overrides (by wordKey) differs from the fixture
    const expected = structuredClone(p);
    expected.media.sort((a, b) => a.id.localeCompare(b.id));
    expected.sequences[0]!.captions!.overrides.reverse();
    expect(back).toEqual(expected);
    expect(canonical(p)).toEqual(expected);
    expect(back.sequences[0]!.captions!.overrides.map((o) => o.wordKey)).toEqual([
      'm_video:r1:0',
      'm_video:r1:2',
    ]);
  });

  test('shuffled arrays give the same canonical project', () => {
    const p = richProject();
    const q = structuredClone(p);
    q.media.reverse();
    q.sequences[0]!.videoTracks[0]!.items.reverse();
    q.sequences[0]!.audioTracks[0]!.items.reverse();
    q.sequences[0]!.captions!.overrides.reverse();
    expect(canonical(q)).toEqual(canonical(p));
    expect(denormalise(normalise(q), projectFrame(q))).toEqual(canonical(p));
  });

  test('wordKeys sort by index numerically', () => {
    const p = richProject();
    p.sequences[0]!.captions!.overrides = [
      { wordKey: 'm_video:r1:10', emphasis: true },
      { wordKey: 'm_video:r1:9', emphasis: true },
    ];
    expect(canonical(p).sequences[0]!.captions!.overrides.map((o) => o.wordKey)).toEqual([
      'm_video:r1:9',
      'm_video:r1:10',
    ]);
  });
});
