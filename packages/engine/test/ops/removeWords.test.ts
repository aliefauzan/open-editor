import { describe, expect, test } from 'vitest';
import { apply, expectCode, trackItems } from '../helpers/ops.ts';
import { K, speechCtx, speechProject } from '../helpers/speech.ts';

const rw = (args: Record<string, unknown>, p = speechProject()) =>
  apply(p, 'removeWords', { sequenceId: 'seq_1', ...args }, speechCtx());

describe('removeWords (D-15)', () => {
  test('cuts the named words exactly (snapped)', () => {
    const out = rw({ wordKeys: [K(8), K(1)] });
    expect((out.report as { ranges: unknown[] }).ranges).toEqual([
      { startMs: 633, endMs: 933, kind: 'filler', wordKeys: [K(1)] },
      { startMs: 2567, endMs: 2900, kind: 'filler', wordKeys: [K(8)] },
    ]);
    expect(trackItems(out.project, 'V1').reduce((n, i) => n + i.durationMs, 0)).toBe(
      7200 - 300 - 333,
    );
  });
  test('dry run writes nothing', () => {
    const p = speechProject();
    const out = rw({ wordKeys: [K(14)], dryRun: true }, p);
    expect(out.project).toBe(p);
    expect((out.report as { ranges: unknown[] }).ranges).toEqual([
      { startMs: 4667, endMs: 4933, kind: 'word', wordKeys: [K(14)] },
    ]);
  });
  test('words not on the timeline fail NOT_FOUND', () => {
    expectCode(() => rw({ wordKeys: ['m_talk:t1:99'] }), 'NOT_FOUND');
    expectCode(() => rw({ wordKeys: ['m_talk:t0:1'] }), 'NOT_FOUND');
  });
  test('needs at least one key', () => {
    expectCode(() => rw({ wordKeys: [] }), 'VALIDATION');
  });
});
