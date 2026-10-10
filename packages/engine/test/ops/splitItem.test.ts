import { describe, expect, test } from 'vitest';
import { FPS_SET, fpsName, onGridFor } from '../helpers/grid.ts';
import { ap, apply, clip, expectCode, spans, trackItems } from '../helpers/ops.ts';
import { richProject, NTSC } from '../helpers/project.ts';

const split = (args: Record<string, unknown>, p = richProject()) =>
  apply(p, 'splitItem', { sequenceId: 'seq_1', ...args });

describe('splitItem', () => {
  test('splits linked items; right parts get new ids and one new shared linkId', () => {
    const out = split({ itemId: 'it_v1', atMs: 2000 });
    const [rv, ra] = (out.report as { itemIds: string[] }).itemIds;
    expect(spans(trackItems(out.project, 'V1'))).toEqual([
      [0, 2000],
      [2000, 5000],
      [5000, 8000],
    ]);
    expect(spans(trackItems(out.project, 'A1'))).toEqual([
      [0, 2000],
      [2000, 5000],
      [5000, 8000],
    ]);
    const r = clip(out.project, rv!);
    expect(r.inMs).toBe(2002); // 2000 ms on the 29.97 source grid
    expect(r.linkId).toBeDefined();
    expect(clip(out.project, ra!).linkId).toBe(r.linkId);
    expect(r.linkId).not.toBe('ln_1');
    expect(clip(out.project, 'it_v1').linkId).toBe('ln_1');
  });
  test('right part keyframes shift; fades split sensibly', () => {
    const p0 = ap(richProject(), 'updateClip', {
      sequenceId: 'seq_1',
      itemId: 'it_a1',
      fadeInMs: 100,
      fadeOutMs: 200,
    });
    const out = split({ itemId: 'it_v1', atMs: 3000 }, p0);
    const [rv, ra] = (out.report as { itemIds: string[] }).itemIds;
    expect(clip(out.project, rv!).frame?.keyframes?.[0]?.atMs).toBe(-2000);
    expect(clip(out.project, 'it_a1').fadeInMs).toBe(100);
    expect(clip(out.project, 'it_a1')).not.toHaveProperty('fadeOutMs');
    expect(clip(out.project, ra!).fadeOutMs).toBe(200);
    expect(clip(out.project, ra!)).not.toHaveProperty('fadeInMs');
  });
  test('unlinked splits only the item; a lone right part has no linkId', () => {
    const out = split({ itemId: 'it_v1', atMs: 2000, unlinked: true });
    expect(trackItems(out.project, 'A1')).toHaveLength(2);
    expect(clip(out.project, (out.report as { itemIds: string[] }).itemIds[0]!)).not.toHaveProperty(
      'linkId',
    );
  });
  test('the point must be strictly inside the item', () => {
    expectCode(() => split({ itemId: 'it_v1', atMs: 0 }), 'VALIDATION');
    expectCode(() => split({ itemId: 'it_v1', atMs: 5000 }), 'VALIDATION');
  });
  test('splitting a scene below its minimum fails DURATION_BOUNDS', () => {
    expectCode(() => split({ itemId: 'it_s1', atMs: 1200 }), 'DURATION_BOUNDS');
    expect(spans(trackItems(split({ itemId: 'it_s1', atMs: 2000 }).project, 'V2'))).toEqual([
      [1000, 2000],
      [2000, 3000],
    ]);
  });
  test.each(FPS_SET.map((f) => [fpsName(f), f] as const))(
    '100 random splits at %s fps leave no gaps and keep every grid',
    (_n, fps) => {
      let p = ap(richProject(), 'updateSequence', { sequenceId: 'seq_1', canvas: { fps } });
      let seed = 7;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let k = 0; k < 100; k++) {
        const items = trackItems(p, 'V1').filter((i) => i.durationMs > 90);
        if (items.length === 0) break;
        const it = items[Math.floor(rnd() * items.length)]!;
        const at = it.startMs + 1 + Math.floor(rnd() * (it.durationMs - 2));
        try {
          p = ap(p, 'splitItem', { sequenceId: 'seq_1', itemId: it.id, atMs: at });
        } catch (e) {
          // a point that snaps onto an edge is rejected; anything else is a bug
          expect((e as { code?: string }).code).toBe('VALIDATION');
        }
      }
      for (const id of ['V1', 'A1']) {
        const items = trackItems(p, id);
        expect(items.length).toBeGreaterThan(20);
        // the track was one contiguous run [0, 8000): it still is, with no 1-frame gaps
        expect(items[0]!.startMs).toBe(0);
        for (let k = 1; k < items.length; k++) {
          expect(items[k]!.startMs).toBe(items[k - 1]!.startMs + items[k - 1]!.durationMs);
        }
        for (const it of items) {
          expect(onGridFor(it.startMs, fps)).toBe(true);
          expect(onGridFor(it.startMs + it.durationMs, fps)).toBe(true);
          if (it.type === 'media') expect(onGridFor(it.inMs, NTSC)).toBe(true);
        }
        const total = items.reduce((n, i) => n + i.durationMs, 0);
        expect(total).toBe(
          trackItems(
            ap(richProject(), 'updateSequence', { sequenceId: 'seq_1', canvas: { fps } }),
            id,
          ).reduce((n, i) => n + i.durationMs, 0),
        );
      }
    },
  );
});
