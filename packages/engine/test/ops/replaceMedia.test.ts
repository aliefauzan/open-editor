import { describe, expect, test } from 'vitest';
import { apply, expectCode, clip, item, ap } from '../helpers/ops.ts';
import { richProject, videoMedia, audioMedia } from '../helpers/project.ts';

describe('replaceMedia', () => {
  test('points every clip at the new media and clamps out-of-range clips', () => {
    const p0 = ap(richProject(), 'addMedia', {
      media: videoMedia('m_short', { durationMs: 9000, fps: { num: 30, den: 1 } }),
    });
    const out = apply(p0, 'replaceMedia', { mediaId: 'm_video', withMediaId: 'm_short' });
    const p = out.project;
    expect(clip(p, 'it_v1').mediaId).toBe('m_short');
    expect(clip(p, 'it_a1').mediaId).toBe('m_short');
    // it_v2: inMs 8008 + 3000 > 9000 → clamped to 1000 ms
    expect(item(p, 'it_v2').durationMs).toBe(1000);
    expect(item(p, 'it_a2').durationMs).toBe(1000);
    expect(out.report).toEqual({ clamped: ['it_a2', 'it_v2'] });
  });
  test('needs the same kind', () => {
    const p0 = ap(richProject(), 'addMedia', { media: audioMedia('m_a2') });
    expectCode(
      () => ap(p0, 'replaceMedia', { mediaId: 'm_video', withMediaId: 'm_a2' }),
      'VALIDATION',
    );
  });
});
