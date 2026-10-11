// setClipSpeed and the speed-aware source arithmetic of the other ops (engine spec "Clip speed",
// plan D-62). richProject: V1 it_v1 0–5000 (in 0) + it_v2 5000–8000 (in 8008), linked to A1
// it_a1/it_a2; a 20 s 29.97 fps source in a 30 fps sequence; a scene on V2 at 1000–3000.
import { describe, expect, test } from 'vitest';
import type { Project } from '../../src/model/schema.ts';
import { ap, clip, expectCode, item, trackItems } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

const speed = (p: Project, itemId: string, s: number, extra: Record<string, unknown> = {}) =>
  ap(p, 'setClipSpeed', { sequenceId: 'seq_1', itemId, speed: s, ...extra });

describe('setClipSpeed', () => {
  test('2× keeps start, in and the source span; linked sound follows; a gap is left by default', () => {
    const p = speed(richProject(), 'it_v1', 2);
    for (const id of ['it_v1', 'it_a1']) {
      expect(clip(p, id)).toMatchObject({ startMs: 0, inMs: 0, durationMs: 2500, speed: 2 });
    }
    expect(clip(p, 'it_v2').startMs).toBe(5000);
    // the manual crop pin stays on the same source moment
    expect(clip(p, 'it_v1').frame?.keyframes?.[0]?.atMs).toBe(500);
  });

  test('ripple closes the gap on the clip tracks and the sync-locked tracks', () => {
    const p = speed(richProject(), 'it_v1', 2, { onOverlap: 'ripple' });
    expect(clip(p, 'it_v2').startMs).toBe(2500);
    expect(clip(p, 'it_a2').startMs).toBe(2500);
    // the V2 scene across the cut range is shortened like any ripple cut
    expect(item(p, 'it_s1')).toMatchObject({ startMs: 1000, durationMs: 1500 });
  });

  test('0.5× gets longer: OVERLAP by default, ripple shifts the later items', () => {
    expectCode(() => speed(richProject(), 'it_v1', 0.5), 'OVERLAP');
    const p = speed(richProject(), 'it_v1', 0.5, { onOverlap: 'ripple' });
    expect(clip(p, 'it_v1')).toMatchObject({ durationMs: 10000, speed: 0.5 });
    expect(clip(p, 'it_a1')).toMatchObject({ durationMs: 10000, speed: 0.5 });
    expect(clip(p, 'it_v2').startMs).toBe(10000);
    expect(clip(p, 'it_a2').startMs).toBe(10000);
    expect(item(p, 'it_s1')).toMatchObject({ startMs: 1000, durationMs: 2000 });
  });

  test('speed 1 removes the field and restores the length', () => {
    const p = speed(speed(richProject(), 'it_v2', 2), 'it_v2', 1);
    expect(clip(p, 'it_v2')).not.toHaveProperty('speed');
    expect(clip(p, 'it_v2').durationMs).toBe(3000);
  });

  test('sound outside 0.5–2× fails VALIDATION; unlinked picture may go to 0.25–4×', () => {
    expectCode(() => speed(richProject(), 'it_v1', 3), 'VALIDATION');
    expectCode(() => speed(richProject(), 'it_v1', 0.4, { onOverlap: 'ripple' }), 'VALIDATION');
    const p = speed(richProject(), 'it_v1', 4, { unlinked: true });
    // 5000 / 4 = 1250 ms is frame 37.5 at 30 fps; the end snaps to the nearest frame (38)
    expect(clip(p, 'it_v1')).toMatchObject({ durationMs: 1267, speed: 4 });
    expect(clip(p, 'it_a1')).not.toHaveProperty('speed');
  });

  test('out-of-range or too precise speeds fail the schema', () => {
    for (const s of [0.2, 4.5, 1.234]) {
      expectCode(() => speed(richProject(), 'it_v1', s, { unlinked: true }), 'VALIDATION');
    }
  });

  test('images and scenes have no speed', () => {
    const withImg = ap(richProject(), 'placeClip', {
      sequenceId: 'seq_1',
      trackId: 'V2',
      mediaId: 'm_img',
      startMs: 10000,
      durationMs: 1000,
    });
    const img = trackItems(withImg, 'V2').find((i) => i.startMs === 10000)!;
    expectCode(() => speed(withImg, img.id, 2), 'VALIDATION');
    expectCode(() => speed(richProject(), 'it_s1', 2), 'VALIDATION');
  });
});

describe('speed-aware source arithmetic', () => {
  const at2 = () => speed(richProject(), 'it_v2', 2); // it_v2/it_a2: 5000–6500, in 8008, span 3000

  test('the duration rule is inMs + durationMs × speed', () => {
    const ok = ap(at2(), 'trimItem', {
      sequenceId: 'seq_1',
      itemId: 'it_v2',
      edge: 'end',
      toMs: 10900, // 5900 × 2 = 11800 ms of source from 8008 → 19808 ≤ 20000
    });
    expect(clip(ok, 'it_v2').durationMs).toBe(5900);
    expectCode(
      () =>
        ap(at2(), 'trimItem', { sequenceId: 'seq_1', itemId: 'it_v2', edge: 'end', toMs: 11000 }),
      'MEDIA_BOUNDS',
    );
  });

  test('trim from the start moves inMs by the trimmed time × speed', () => {
    const p = ap(at2(), 'trimItem', {
      sequenceId: 'seq_1',
      itemId: 'it_v2',
      edge: 'start',
      toMs: 5500,
    });
    // 500 ms × 2 = 1000 ms of source → 9008, snapped to the 29.97 grid (frame 270 = 9009)
    expect(clip(p, 'it_v2')).toMatchObject({ startMs: 5500, durationMs: 1000, inMs: 9009 });
  });

  test('split gives the right part inMs + offset × speed', () => {
    const p = ap(at2(), 'splitItem', { sequenceId: 'seq_1', itemId: 'it_v2', atMs: 6000 });
    const right = trackItems(p, 'V1').find((i) => i.startMs === 6000)!;
    expect(right).toMatchObject({ durationMs: 500, speed: 2, inMs: 10010 });
  });

  test('NO_HANDLES counts handles in source time (× speed)', () => {
    const p = richProject();
    const v2 = p.sequences[0]!.videoTracks[0]!.items[1]!;
    if (v2.type !== 'media') throw new Error('fixture');
    v2.inMs = 1001; // 1 s of source before the cut
    delete v2.linkId;
    const fade = { template: 'test/crossfade', durationMs: 1000 };
    // at 1× a 1000 ms crossfade needs 500 ms before the cut: fine
    ap(p, 'setTransition', { sequenceId: 'seq_1', itemId: 'it_v2', transition: fade });
    // at 4× it needs 2000 ms of source
    const fast = speed(p, 'it_v2', 4);
    expectCode(
      () => ap(fast, 'setTransition', { sequenceId: 'seq_1', itemId: 'it_v2', transition: fade }),
      'NO_HANDLES',
    );
  });
});
