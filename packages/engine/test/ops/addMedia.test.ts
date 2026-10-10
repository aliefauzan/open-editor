import { describe, expect, test } from 'vitest';
import { ap, expectCode } from '../helpers/ops.ts';
import { baseProject, videoMedia } from '../helpers/project.ts';

describe('addMedia', () => {
  test('adds a library entry', () => {
    const p = ap(baseProject(), 'addMedia', { media: videoMedia('m_new') });
    expect(p.media.map((m) => m.id)).toContain('m_new');
  });
  test('a duplicate id fails', () => {
    expectCode(() => ap(baseProject(), 'addMedia', { media: videoMedia('m_video') }), 'VALIDATION');
  });
  test('a path outside the project fails', () => {
    expectCode(
      () => ap(baseProject(), 'addMedia', { media: videoMedia('m_x', { path: '../x.mp4' }) }),
      'VALIDATION',
    );
  });
  test('unknown args fail', () => {
    expectCode(
      () => ap(baseProject(), 'addMedia', { media: videoMedia('m_y'), extra: 1 }),
      'VALIDATION',
    );
  });
});
