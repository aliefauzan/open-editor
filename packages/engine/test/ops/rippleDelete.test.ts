import { describe, expect, test } from 'vitest';
import { ap, clip, expectCode, scene, spans, trackItems } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

const ripple = (args: Record<string, unknown>, p = richProject()) =>
  ap(p, 'rippleDelete', { sequenceId: 'seq_1', ...args });

describe('rippleDelete', () => {
  test('cuts the range on the track, linked tracks and sync-locked tracks, and closes the gap', () => {
    const p = ripple({ trackId: 'A1', startMs: 2000, endMs: 2500 });
    expect(spans(trackItems(p, 'A1'))).toEqual([
      [0, 2000],
      [2000, 4500],
      [4500, 7500],
    ]);
    expect(spans(trackItems(p, 'V1'))).toEqual([
      [0, 2000],
      [2000, 4500],
      [4500, 7500],
    ]);
    // the scene across the range is shortened, not split
    expect(spans(trackItems(p, 'V2'))).toEqual([[1000, 2500]]);
    expect(scene(p, 'it_s1').durationMs).toBe(1500);
  });
  test('the right part of a split keeps the source position and its link', () => {
    const p = ripple({ trackId: 'A1', startMs: 2000, endMs: 2500 });
    const v = trackItems(p, 'V1')[1]!;
    const a = trackItems(p, 'A1')[1]!;
    expect(v.type === 'media' && v.inMs).toBe(2503); // 2500 on the 29.97 source grid
    expect(v.linkId).toBe(a.linkId);
    expect(v.linkId).not.toBe('ln_1');
  });
  test('items fully inside go; edges trim (start trims shift keyframes)', () => {
    const p = ripple({ trackId: 'V1', startMs: 4000, endMs: 6000 });
    expect(spans(trackItems(p, 'V1'))).toEqual([
      [0, 4000],
      [4000, 6000],
    ]);
    expect(clip(p, 'it_v2').inMs).toBe(9009);
  });
  test('a track without sync lock and without linked items is untouched', () => {
    let p = ap(richProject(), 'updateTrack', {
      sequenceId: 'seq_1',
      trackId: 'V2',
      syncLock: false,
    });
    p = ripple({ trackId: 'A1', startMs: 0, endMs: 500 }, p);
    expect(spans(trackItems(p, 'V2'))).toEqual([[1000, 3000]]);
  });
  test('a locked track in the way fails TRACK_LOCKED naming it', () => {
    const p = ap(richProject(), 'updateTrack', {
      sequenceId: 'seq_1',
      trackId: 'V2',
      locked: true,
    });
    try {
      ripple({ trackId: 'A1', startMs: 0, endMs: 500 }, p);
      throw new Error('no error');
    } catch (e) {
      expect((e as { code: string }).code).toBe('TRACK_LOCKED');
      expect((e as { details: { trackId: string } }).details.trackId).toBe('V2');
      expect((e as Error).message).toContain('V2');
    }
  });
  test('startMs must be before endMs', () => {
    expectCode(() => ripple({ trackId: 'A1', startMs: 500, endMs: 500 }), 'VALIDATION');
  });
});
