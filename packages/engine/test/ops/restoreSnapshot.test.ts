import { describe, expect, test } from 'vitest';
import { ap, expectCode, testCtx } from '../helpers/ops.ts';
import { baseProject, richProject } from '../helpers/project.ts';

describe('restoreSnapshot', () => {
  test('replaces sequences and media with the snapshot', () => {
    const snap = richProject();
    const ctx = testCtx({ snapshot: (n) => (n === 'before-edit' ? snap : undefined) });
    const p = ap(baseProject(), 'restoreSnapshot', { name: 'before-edit' }, ctx);
    expect(p.sequences).toEqual(snap.sequences);
    expect(p.media).toEqual([...snap.media].sort((a, b) => a.id.localeCompare(b.id)));
    expect(p.id).toBe('p_test');
  });
  test('unknown snapshot fails NOT_FOUND; bad names fail VALIDATION', () => {
    expectCode(() => ap(baseProject(), 'restoreSnapshot', { name: 'nope' }), 'NOT_FOUND');
    expectCode(() => ap(baseProject(), 'restoreSnapshot', { name: '../x' }), 'VALIDATION');
    expectCode(() => ap(baseProject(), 'restoreSnapshot', { name: '..' }), 'VALIDATION');
  });
});
