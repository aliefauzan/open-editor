import { describe, expect, test } from 'vitest';
import { ap, expectCode, trackItems } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

describe('removeItem', () => {
  test('removes linked items too', () => {
    const p = ap(richProject(), 'removeItem', { sequenceId: 'seq_1', itemId: 'it_v2' });
    expect(trackItems(p, 'V1').map((i) => i.id)).toEqual(['it_v1']);
    expect(trackItems(p, 'A1').map((i) => i.id)).toEqual(['it_a1']);
  });
  test('unlinked: true removes only the item', () => {
    const p = ap(richProject(), 'removeItem', {
      sequenceId: 'seq_1',
      itemId: 'it_v2',
      unlinked: true,
    });
    expect(trackItems(p, 'A1').map((i) => i.id)).toEqual(['it_a1', 'it_a2']);
  });
  test('unknown item fails NOT_FOUND', () => {
    expectCode(
      () => ap(richProject(), 'removeItem', { sequenceId: 'seq_1', itemId: 'it_none' }),
      'NOT_FOUND',
    );
  });
});
