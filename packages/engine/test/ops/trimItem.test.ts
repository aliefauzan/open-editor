import { describe, expect, test } from 'vitest';
import { FPS_SET, fpsName, onGridFor } from '../helpers/grid.ts';
import { ap, clip, expectCode, scene } from '../helpers/ops.ts';
import { richProject, NTSC } from '../helpers/project.ts';

const trim = (args: Record<string, unknown>, p = richProject()) =>
  ap(p, 'trimItem', { sequenceId: 'seq_1', ...args });

describe('trimItem', () => {
  test('end edge trims linked items too', () => {
    const p = trim({ itemId: 'it_v2', edge: 'end', toMs: 7000 });
    expect([clip(p, 'it_v2').durationMs, clip(p, 'it_a2').durationMs]).toEqual([2000, 2000]);
  });
  test('start edge moves start and inMs (source grid) and shifts keyframes (6a)', () => {
    const p = trim({ itemId: 'it_v1', edge: 'start', toMs: 500 });
    const c = clip(p, 'it_v1');
    expect([c.startMs, c.durationMs]).toEqual([500, 4500]);
    expect(c.inMs).toBe(501); // 500 ms snapped to the 29.97 source grid
    expect(c.frame?.keyframes?.[0]?.atMs).toBe(500);
    expect(clip(p, 'it_a1').startMs).toBe(500);
  });
  test('unlinked trims only the item', () => {
    const p = trim({ itemId: 'it_v2', edge: 'end', toMs: 7000, unlinked: true });
    expect(clip(p, 'it_a2').durationMs).toBe(3000);
  });
  test('MEDIA_BOUNDS when trimming past the media', () => {
    const p = ap(richProject(), 'moveItem', {
      sequenceId: 'seq_1',
      itemId: 'it_v2',
      startMs: 15000,
    });
    expectCode(() => trim({ itemId: 'it_v2', edge: 'end', toMs: 30000 }, p), 'MEDIA_BOUNDS');
    expectCode(
      () =>
        trim(
          { itemId: 'it_v1', edge: 'start', toMs: 0 },
          ap(richProject(), 'moveItem', { sequenceId: 'seq_1', itemId: 'it_v1', startMs: 10000 }),
        ),
      'MEDIA_BOUNDS',
    );
  });
  test('trimming to nothing fails', () => {
    expectCode(() => trim({ itemId: 'it_v2', edge: 'end', toMs: 5000 }), 'VALIDATION');
  });
  test('extending into a neighbour fails OVERLAP', () => {
    expectCode(() => trim({ itemId: 'it_v1', edge: 'end', toMs: 6000 }), 'OVERLAP');
  });
  test('scenes trim within template bounds', () => {
    expect(scene(trim({ itemId: 'it_s1', edge: 'end', toMs: 4000 }), 'it_s1').durationMs).toBe(
      3000,
    );
    expectCode(() => trim({ itemId: 'it_s1', edge: 'end', toMs: 1300 }), 'DURATION_BOUNDS');
  });
  test.each(FPS_SET.map((f) => [fpsName(f), f] as const))(
    'at %s fps, a 29.97 source keeps inMs on the source grid after trims',
    (_n, fps) => {
      let p = ap(richProject(), 'updateSequence', { sequenceId: 'seq_1', canvas: { fps } });
      for (const to of [333, 777, 1234, 2001]) {
        p = trim({ itemId: 'it_v1', edge: 'start', toMs: to }, p);
        const c = clip(p, 'it_v1');
        expect(onGridFor(c.inMs, NTSC)).toBe(true);
        expect(onGridFor(c.startMs, fps)).toBe(true);
      }
    },
  );
});
