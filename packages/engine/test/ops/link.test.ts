import { describe, expect, test } from 'vitest';
import { ap, apply, clip, expectCode, scene } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

describe('link / unlink', () => {
  test('link sets one new linkId on two or more items', () => {
    const out = apply(richProject(), 'link', { sequenceId: 'seq_1', itemIds: ['it_v2', 'it_s1'] });
    const id = (out.report as { linkId: string }).linkId;
    expect(clip(out.project, 'it_v2').linkId).toBe(id);
    expect(scene(out.project, 'it_s1').linkId).toBe(id);
    expectCode(
      () => ap(richProject(), 'link', { sequenceId: 'seq_1', itemIds: ['it_v2'] }),
      'VALIDATION',
    );
  });
  test('unlink clears linkId', () => {
    const p = ap(richProject(), 'unlink', { sequenceId: 'seq_1', itemIds: ['it_v1', 'it_a1'] });
    expect(clip(p, 'it_v1')).not.toHaveProperty('linkId');
    expect(clip(p, 'it_a1')).not.toHaveProperty('linkId');
  });
});
