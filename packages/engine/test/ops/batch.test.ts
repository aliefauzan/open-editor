import { describe, expect, test } from 'vitest';
import { apply, expectCode, trackItems } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

describe('batch', () => {
  test('applies ops in order and reports one step per op', () => {
    const out = apply(richProject(), 'batch', {
      ops: [
        { op: 'removeItem', args: { sequenceId: 'seq_1', itemId: 'it_v2' } },
        { op: 'addTrack', args: { sequenceId: 'seq_1', kind: 'video' } },
      ],
    });
    expect(out.steps.map((s) => s.op)).toEqual(['removeItem', 'addTrack']);
    expect(out.steps[1]!.report).toEqual({ trackId: 'V3' });
    expect(trackItems(out.project, 'V1')).toHaveLength(1);
  });
  test('is atomic: one failing op throws with its index and nothing is returned', () => {
    const p = richProject();
    try {
      apply(p, 'batch', {
        ops: [
          { op: 'removeItem', args: { sequenceId: 'seq_1', itemId: 'it_v2' } },
          { op: 'removeItem', args: { sequenceId: 'seq_1', itemId: 'it_none' } },
        ],
      });
      throw new Error('no error');
    } catch (e) {
      expect((e as { code: string }).code).toBe('NOT_FOUND');
      expect((e as { details: { batchIndex: number } }).details.batchIndex).toBe(1);
    }
    expect(trackItems(p, 'V1')).toHaveLength(2);
  });
  test('no nested batch, no dryRun inside', () => {
    expectCode(
      () => apply(richProject(), 'batch', { ops: [{ op: 'batch', args: { ops: [] } }] }),
      'VALIDATION',
    );
    expectCode(
      () =>
        apply(richProject(), 'batch', {
          ops: [{ op: 'removePauses', args: { sequenceId: 'seq_1', dryRun: true } }],
        }),
      'VALIDATION',
    );
  });
  test('unknown ops fail VALIDATION', () => {
    expectCode(
      () => apply(richProject(), 'batch', { ops: [{ op: 'explode', args: {} }] }),
      'VALIDATION',
    );
    expectCode(() => apply(richProject(), 'explode', {}), 'VALIDATION');
  });
});
