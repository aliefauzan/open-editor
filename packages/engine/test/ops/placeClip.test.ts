import { describe, expect, test } from 'vitest';
import { ap, apply, clip, expectCode, spans, trackItems } from '../helpers/ops.ts';
import { baseProject, richProject } from '../helpers/project.ts';

const place = (args: Record<string, unknown>, p = baseProject()) =>
  apply(p, 'placeClip', { sequenceId: 'seq_1', trackId: 'V1', mediaId: 'm_video', ...args });

describe('placeClip', () => {
  test('a video with sound makes a linked picture + sound pair on A1', () => {
    const out = place({ startMs: 1000, durationMs: 2000 });
    const [v, a] = (out.report as { itemIds: string[] }).itemIds;
    const pic = clip(out.project, v!);
    const snd = clip(out.project, a!);
    expect(pic.trackId).toBe('V1');
    expect(snd.trackId).toBe('A1');
    expect(pic.linkId).toBeDefined();
    expect(snd.linkId).toBe(pic.linkId);
    expect([snd.startMs, snd.durationMs, snd.inMs]).toEqual([
      pic.startMs,
      pic.durationMs,
      pic.inMs,
    ]);
  });
  test('withAudio: false and audioTrackId', () => {
    expect(
      trackItems(place({ startMs: 0, durationMs: 1000, withAudio: false }).project, 'A1'),
    ).toHaveLength(0);
    expect(
      trackItems(place({ startMs: 0, durationMs: 1000, audioTrackId: 'A2' }).project, 'A2'),
    ).toHaveLength(1);
  });
  test('durationMs defaults to the rest of the media, snapped down to the grid', () => {
    const out = place({ startMs: 10000, inMs: 1001, withAudio: false });
    const c = clip(out.project, (out.report as { itemIds: string[] }).itemIds[0]!);
    expect(c.inMs + c.durationMs).toBeLessThanOrEqual(20000);
    expect(c.inMs + c.durationMs).toBeGreaterThan(20000 - 34);
  });
  test('inMs snaps to the 29.97 source grid in a 30 fps sequence', () => {
    const out = place({ startMs: 0, inMs: 1000, durationMs: 1000 });
    expect(clip(out.project, (out.report as { itemIds: string[] }).itemIds[0]!).inMs).toBe(1001);
  });
  test('images need durationMs; inMs is 0', () => {
    expectCode(() => place({ mediaId: 'm_img', startMs: 0 }), 'VALIDATION');
    const out = place({
      mediaId: 'm_img',
      startMs: 0,
      durationMs: 3000,
      inMs: 500,
      motion: { type: 'push-in', amount: 0.1 },
    });
    const c = clip(out.project, (out.report as { itemIds: string[] }).itemIds[0]!);
    expect([c.inMs, c.durationMs, c.motion?.type]).toEqual([0, 3000, 'push-in']);
  });
  test('motion is for images only', () => {
    expectCode(
      () => place({ startMs: 0, durationMs: 1000, motion: { type: 'pan', amount: 1 } }),
      'VALIDATION',
    );
  });
  test('frame goes on the picture clip, sound settings on the sound clip', () => {
    const out = place({
      startMs: 0,
      durationMs: 1000,
      frame: { mode: 'auto', stability: 'locked' },
      volume: 0.5,
      fadeInMs: 100,
      denoise: 'light',
    });
    const [v, a] = (out.report as { itemIds: string[] }).itemIds;
    expect(clip(out.project, v!).frame).toEqual({ mode: 'auto', stability: 'locked' });
    expect(clip(out.project, v!)).not.toHaveProperty('volume');
    expect(clip(out.project, a!)).toMatchObject({ volume: 0.5, fadeInMs: 100, denoise: 'light' });
    expect(clip(out.project, a!)).not.toHaveProperty('frame');
  });
  test('track kinds: audio media on a video track, image on an audio track, documents never', () => {
    expectCode(() => place({ mediaId: 'm_aud', startMs: 0, durationMs: 1000 }), 'TRACK_KIND');
    expectCode(
      () => place({ mediaId: 'm_img', trackId: 'A1', startMs: 0, durationMs: 1000 }),
      'TRACK_KIND',
    );
    const p = ap(baseProject(), 'addMedia', {
      media: {
        id: 'm_doc',
        kind: 'document',
        path: 'media/m_doc.pdf',
        origin: { type: 'upload' },
        tags: [],
      },
    });
    expectCode(() => place({ mediaId: 'm_doc', startMs: 0, durationMs: 1000 }, p), 'TRACK_KIND');
  });
  test('a video with sound may go on an audio track alone (sound used)', () => {
    const out = place({ trackId: 'A2', startMs: 0, durationMs: 1000 });
    expect(trackItems(out.project, 'A2')).toHaveLength(1);
    expect(trackItems(out.project, 'V1')).toHaveLength(0);
  });
  test('media bounds: inMs + durationMs past the end fails', () => {
    expectCode(() => place({ startMs: 0, inMs: 18018, durationMs: 5000 }), 'MEDIA_BOUNDS');
  });
  test("onOverlap 'error' (default) fails OVERLAP", () => {
    expectCode(() => place({ startMs: 4000, durationMs: 2000 }, richProject()), 'OVERLAP');
  });
  test("onOverlap 'overwrite' clears the range on the target tracks only", () => {
    const out = place(
      { startMs: 4000, durationMs: 2000, withAudio: false, onOverlap: 'overwrite' },
      richProject(),
    );
    expect(spans(trackItems(out.project, 'V1'))).toEqual([
      [0, 4000],
      [4000, 6000],
      [6000, 8000],
    ]);
    // linked A1 items are left alone
    expect(spans(trackItems(out.project, 'A1'))).toEqual([
      [0, 5000],
      [5000, 8000],
    ]);
  });
  test("onOverlap 'insert' splits at the point and shifts the target + sync-locked tracks", () => {
    const out = place({ startMs: 4000, durationMs: 2000, onOverlap: 'insert' }, richProject());
    expect(spans(trackItems(out.project, 'V1'))).toEqual([
      [0, 4000],
      [4000, 6000],
      [6000, 7000],
      [7000, 10000],
    ]);
    expect(spans(trackItems(out.project, 'A1'))).toEqual([
      [0, 4000],
      [4000, 6000],
      [6000, 7000],
      [7000, 10000],
    ]);
    // the V2 scene ends before 4000 and stays
    expect(spans(trackItems(out.project, 'V2'))).toEqual([[1000, 3000]]);
    // the split right parts of the linked pair share one new linkId
    const v = trackItems(out.project, 'V1')[2]!;
    const a = trackItems(out.project, 'A1')[2]!;
    expect(v.linkId).toBeDefined();
    expect(v.linkId).toBe(a.linkId);
    expect(v.linkId).not.toBe('ln_1');
  });
  test('unknown media and track fail NOT_FOUND', () => {
    expectCode(() => place({ mediaId: 'm_none', startMs: 0, durationMs: 100 }), 'NOT_FOUND');
    expectCode(() => place({ trackId: 'V9', startMs: 0, durationMs: 100 }), 'NOT_FOUND');
  });
});
