import { describe, expect, test } from 'vitest';
import { ap, clip, expectCode, item, spans, trackItems } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

const move = (args: Record<string, unknown>, p = richProject()) =>
  ap(p, 'moveItem', { sequenceId: 'seq_1', ...args });

describe('moveItem', () => {
  test('linked items move by the same delta and stay on their tracks', () => {
    const p = move({ itemId: 'it_v2', startMs: 9000 });
    expect([clip(p, 'it_v2').startMs, clip(p, 'it_a2').startMs]).toEqual([9000, 9000]);
    expect(item(p, 'it_a2').trackId).toBe('A1');
  });
  test('unlinked: true moves only the item', () => {
    const p = move({ itemId: 'it_v2', startMs: 9000, unlinked: true });
    expect([clip(p, 'it_v2').startMs, clip(p, 'it_a2').startMs]).toEqual([9000, 5000]);
  });
  test('trackId changes the track of the item only', () => {
    const p = move({ itemId: 'it_v2', trackId: 'V2', startMs: 5000 });
    expect(item(p, 'it_v2').trackId).toBe('V2');
    expect(item(p, 'it_a2').trackId).toBe('A1');
  });
  test('start snaps to the grid', () => {
    expect(clip(move({ itemId: 'it_v2', startMs: 9012 }), 'it_v2').startMs).toBe(9000);
  });
  test('keyframes keep their relative atMs (6a)', () => {
    const p = move({ itemId: 'it_v1', startMs: 10000 });
    expect(clip(p, 'it_v1').frame?.keyframes?.[0]?.atMs).toBe(1000);
  });
  test("onOverlap 'error' / 'overwrite' / 'insert'", () => {
    expectCode(() => move({ itemId: 'it_v2', startMs: 3000 }), 'OVERLAP');
    const ow = move({ itemId: 'it_v2', startMs: 3000, onOverlap: 'overwrite' });
    expect(spans(trackItems(ow, 'V1'))).toEqual([
      [0, 3000],
      [3000, 6000],
    ]);
    expect(spans(trackItems(ow, 'A1'))).toEqual([
      [0, 3000],
      [3000, 6000],
    ]);
    const ins = move({ itemId: 'it_v2', startMs: 2000, onOverlap: 'insert' });
    // it_v1 splits at 2000; its right part shifts by 3000
    expect(spans(trackItems(ins, 'V1'))).toEqual([
      [0, 2000],
      [2000, 5000],
      [5000, 8000],
    ]);
    // the scene on sync-locked V2 spans 2000: split and shifted too
    expect(spans(trackItems(ins, 'V2'))).toEqual([
      [1000, 2000],
      [5000, 6000],
    ]);
  });
  test('moving to a wrong-kind track fails TRACK_KIND', () => {
    expectCode(() => move({ itemId: 'it_s1', trackId: 'A2' }), 'TRACK_KIND');
  });
});
