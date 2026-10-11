// Rules enforced by every op (engine spec "Rules enforced by every operation"), at every rate.
import { describe, expect, test } from 'vitest';
import { FPS_SET, fpsName, onGridFor } from '../helpers/grid.ts';
import { ap, expectCode, spans, testCtx, trackItems } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';
import type { Fps, Project } from '../../src/model/schema.ts';

const S = { sequenceId: 'seq_1' };
const lock = (p: Project, trackId: string, extra: Record<string, unknown> = {}) =>
  ap(p, 'updateTrack', { ...S, trackId, locked: true, ...extra });

describe('locked tracks', () => {
  test('reject edits of their items (TRACK_LOCKED names the track)', () => {
    const p = lock(richProject(), 'V1');
    for (const [op, args] of [
      ['moveItem', { itemId: 'it_v2', startMs: 9000, unlinked: true }],
      ['trimItem', { itemId: 'it_v2', edge: 'end', toMs: 7000, unlinked: true }],
      ['splitItem', { itemId: 'it_v2', atMs: 6000, unlinked: true }],
      ['removeItem', { itemId: 'it_v2', unlinked: true }],
      ['updateClip', { itemId: 'it_v2', frame: { mode: 'cover' } }],
      [
        'setTransition',
        { itemId: 'it_v2', transition: { template: 'test/wipe', durationMs: 500 } },
      ],
      ['placeClip', { trackId: 'V1', mediaId: 'm_img', startMs: 9000, durationMs: 1000 }],
    ] as const) {
      try {
        ap(p, op, { ...S, ...args });
        throw new Error(`${op} did not fail`);
      } catch (e) {
        expect((e as { code?: string }).code, op).toBe('TRACK_LOCKED');
        expect((e as { details?: { trackId?: string } }).details?.trackId).toBe('V1');
      }
    }
  });
  test('linked items on a locked track block the whole group', () => {
    expectCode(
      () => ap(lock(richProject(), 'A1'), 'moveItem', { ...S, itemId: 'it_v2', startMs: 9000 }),
      'TRACK_LOCKED',
    );
  });
  test('reject shifts caused by insert on a sync-locked track', () => {
    const p = lock(richProject(), 'A1');
    expectCode(
      () =>
        ap(p, 'addScene', {
          ...S,
          trackId: 'V2',
          startMs: 0,
          durationMs: 1000,
          template: 'test/title',
          variables: { title: 'x' },
          onOverlap: 'insert',
        }),
      'TRACK_LOCKED',
    );
  });
  test('a locked track without sync lock is left alone by insert and ripple', () => {
    const p = lock(richProject(), 'A2', { syncLock: false });
    const q = ap(p, 'rippleDelete', { ...S, trackId: 'V2', startMs: 0, endMs: 500 });
    expect(spans(trackItems(q, 'V2'))).toEqual([[500, 2500]]);
  });
  test('unlocking is allowed', () => {
    const p = ap(lock(richProject(), 'V1'), 'updateTrack', { ...S, trackId: 'V1', locked: false });
    expect(() => ap(p, 'removeItem', { ...S, itemId: 'it_v2' })).not.toThrow();
  });
});

function checkGrid(p: Project, fps: Fps): void {
  for (const t of [...p.sequences[0]!.videoTracks, ...p.sequences[0]!.audioTracks]) {
    let end = 0;
    for (const i of t.items) {
      expect(onGridFor(i.startMs, fps), `${i.id} start ${i.startMs}`).toBe(true);
      expect(onGridFor(i.startMs + i.durationMs, fps), `${i.id} end`).toBe(true);
      expect(i.startMs).toBeGreaterThanOrEqual(end);
      end = i.startMs + i.durationMs;
    }
  }
}

describe.each(FPS_SET.map((f) => [fpsName(f), f] as const))('at %s fps', (_n, fps) => {
  const start = () => ap(richProject(), 'updateSequence', { ...S, canvas: { fps } });
  test('a sequence of edits keeps every item on the grid with no overlaps', () => {
    const ctx = testCtx();
    let p = start();
    const steps: [string, Record<string, unknown>][] = [
      [
        'placeClip',
        { trackId: 'V1', mediaId: 'm_video', startMs: 8000, inMs: 3003, durationMs: 2345 },
      ],
      ['moveItem', { itemId: 'it_v2', startMs: 5111, onOverlap: 'overwrite' }],
      ['trimItem', { itemId: 'it_v1', edge: 'start', toMs: 333 }],
      ['trimItem', { itemId: 'it_v1', edge: 'end', toMs: 4777 }],
      ['splitItem', { itemId: 'it_v1', atMs: 2222 }],
      ['rippleDelete', { trackId: 'A1', startMs: 1111, endMs: 1789 }],
      [
        'addScene',
        {
          trackId: 'V2',
          startMs: 2600,
          durationMs: 1234,
          template: 'test/title',
          variables: { title: 'x' },
          onOverlap: 'insert',
        },
      ],
      [
        'placeClip',
        { trackId: 'V1', mediaId: 'm_img', startMs: 2500, durationMs: 1001, onOverlap: 'insert' },
      ],
    ];
    for (const [op, args] of steps) {
      p = ap(p, op, { ...S, ...args }, ctx);
      checkGrid(p, fps);
    }
  });
  test('media duration bound holds after ripple shifts that re-round durations', () => {
    let p = start();
    p = ap(p, 'removeItem', { ...S, itemId: 'it_v2' });
    p = ap(p, 'placeClip', { ...S, trackId: 'V1', mediaId: 'm_video', startMs: 6000, inMs: 15015 });
    for (const [a, b] of [
      [100, 233],
      [300, 517],
      [1000, 1777],
    ]) {
      p = ap(p, 'rippleDelete', { ...S, trackId: 'V2', startMs: a, endMs: b });
      for (const i of trackItems(p, 'V1')) {
        if (i.type === 'media') expect(i.inMs + i.durationMs).toBeLessThanOrEqual(20000);
      }
      checkGrid(p, fps);
    }
  });
});
