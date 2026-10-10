import { describe, expect, test } from 'vitest';
import { ap, expectCode } from '../helpers/ops.ts';
import { baseProject } from '../helpers/project.ts';

describe('updateMedia', () => {
  test('patches fields and null clears an optional field', () => {
    const p = ap(baseProject(), 'updateMedia', {
      mediaId: 'm_video',
      patch: { tags: ['speaker'], description: 'talk', transcriptRev: null },
    });
    const m = p.media.find((x) => x.id === 'm_video')!;
    expect(m.tags).toEqual(['speaker']);
    expect(m.description).toBe('talk');
    expect(m).not.toHaveProperty('transcriptRev');
  });
  test('id and kind cannot change', () => {
    expectCode(
      () => ap(baseProject(), 'updateMedia', { mediaId: 'm_video', patch: { kind: 'audio' } }),
      'VALIDATION',
    );
    expectCode(
      () => ap(baseProject(), 'updateMedia', { mediaId: 'm_video', patch: { id: 'm_z' } }),
      'VALIDATION',
    );
  });
  test('unknown media fails NOT_FOUND', () => {
    expectCode(
      () => ap(baseProject(), 'updateMedia', { mediaId: 'm_nope', patch: { tags: [] } }),
      'NOT_FOUND',
    );
  });
});
