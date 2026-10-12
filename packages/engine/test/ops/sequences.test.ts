import { describe, expect, test } from 'vitest';
import { FPS_SET, onGridFor } from '../helpers/grid.ts';
import { ap, apply, clip, expectCode, item, seq } from '../helpers/ops.ts';
import { baseProject, richProject, F30, NTSC } from '../helpers/project.ts';

describe('addSequence', () => {
  test('defaults: 1080x1920, 30/1, base style, V1 V2 A1 A2, captions off', () => {
    const p0 = baseProject();
    const out = apply(p0, 'addSequence', { name: 'Short' });
    const id = (out.report as { sequenceId: string }).sequenceId;
    const s = seq(out.project, id);
    expect(s.canvas).toEqual({ width: 1080, height: 1920, fps: F30 });
    expect(s.styleId).toBe('base');
    expect(s.videoTracks.map((t) => t.id)).toEqual(['V1', 'V2']);
    expect(s.audioTracks.map((t) => t.id)).toEqual(['A1', 'A2']);
    expect(s.videoTracks.every((t) => t.syncLock && !t.locked)).toBe(true);
    expect(s.captions).toBeNull();
    expect(s.sfx).toBe(true);
  });
  test('takes id, canvas and styleId; a duplicate id fails', () => {
    const p = ap(baseProject(), 'addSequence', {
      name: 'W',
      id: 'seq_w',
      canvas: { width: 1920, height: 1080, fps: NTSC },
      styleId: 'vox',
    });
    expect(seq(p, 'seq_w').canvas.fps).toEqual(NTSC);
    expectCode(() => ap(p, 'addSequence', { name: 'X', id: 'seq_w' }), 'VALIDATION');
  });
  test('an fps outside the fixed set fails', () => {
    expectCode(
      () => ap(baseProject(), 'addSequence', { name: 'X', canvas: { fps: { num: 29, den: 1 } } }),
      'VALIDATION',
    );
  });
});

describe('updateSequence', () => {
  test('name, styleId, sfx, overlays (null clears), sourceRange (null clears)', () => {
    let p = ap(baseProject(), 'updateSequence', {
      sequenceId: 'seq_1',
      name: 'N',
      styleId: 'vox',
      sfx: false,
      overlays: ['vox/grain'],
      sourceRange: { mediaId: 'm_video', inMs: 1000, outMs: 5000 },
    });
    let s = seq(p);
    expect([s.name, s.styleId, s.sfx, s.overlays]).toEqual(['N', 'vox', false, ['vox/grain']]);
    expect(s.sourceRange).toEqual({ mediaId: 'm_video', inMs: 1000, outMs: 5000 });
    p = ap(p, 'updateSequence', { sequenceId: 'seq_1', overlays: null, sourceRange: null });
    s = seq(p);
    expect(s).not.toHaveProperty('overlays');
    expect(s).not.toHaveProperty('sourceRange');
  });
  test('sourceRange needs known media and inMs < outMs', () => {
    expectCode(
      () =>
        ap(baseProject(), 'updateSequence', {
          sequenceId: 'seq_1',
          sourceRange: { mediaId: 'm_no', inMs: 0, outMs: 5 },
        }),
      'NOT_FOUND',
    );
    expectCode(
      () =>
        ap(baseProject(), 'updateSequence', {
          sequenceId: 'seq_1',
          sourceRange: { mediaId: 'm_video', inMs: 5, outMs: 5 },
        }),
      'VALIDATION',
    );
  });
  test.each(FPS_SET.map((f) => [`${f.num}/${f.den}`, f] as const))(
    'fps change to %s re-snaps every item in one op',
    (_n, fps) => {
      const out = apply(richProject(F30), 'updateSequence', {
        sequenceId: 'seq_1',
        canvas: { fps },
      });
      const s = seq(out.project);
      expect(s.canvas.fps).toEqual(fps);
      for (const t of [...s.videoTracks, ...s.audioTracks]) {
        for (const it of t.items) {
          expect(onGridFor(it.startMs, fps)).toBe(true);
          expect(onGridFor(it.startMs + it.durationMs, fps)).toBe(true);
        }
        for (let k = 1; k < t.items.length; k++) {
          expect(t.items[k - 1]!.startMs + t.items[k - 1]!.durationMs).toBeLessThanOrEqual(
            t.items[k]!.startMs,
          );
        }
      }
      expect(out.steps).toHaveLength(1);
    },
  );
  test('unknown sequence fails NOT_FOUND', () => {
    expectCode(
      () => ap(baseProject(), 'updateSequence', { sequenceId: 'seq_none', name: 'x' }),
      'NOT_FOUND',
    );
  });
});

describe('duplicateSequence / removeSequence', () => {
  test('duplicate gives new item ids and keeps link groups with new link ids', () => {
    const out = apply(richProject(), 'duplicateSequence', { sequenceId: 'seq_1' });
    const id = (out.report as { sequenceId: string }).sequenceId;
    const copy = seq(out.project, id);
    expect(copy.name).toBe('Clip 1 copy');
    const v1 = copy.videoTracks[0]!.items[0]!;
    const a1 = copy.audioTracks[0]!.items[0]!;
    expect(v1.id).not.toBe('it_v1');
    expect(v1.linkId).toBeDefined();
    expect(v1.linkId).not.toBe('ln_1');
    expect(a1.linkId).toBe(v1.linkId);
    expect(copy.captions?.overrides).toHaveLength(2);
    expect(clip(out.project, 'it_v1').linkId).toBe('ln_1');
  });
  test('remove drops the sequence', () => {
    const p = ap(richProject(), 'removeSequence', { sequenceId: 'seq_1' });
    expect(p.sequences).toEqual([]);
  });
});

describe('tracks', () => {
  test('addTrack adds the next V<n>/A<n> on top', () => {
    const out = apply(baseProject(), 'addTrack', {
      sequenceId: 'seq_1',
      kind: 'video',
      name: 'Titles',
    });
    expect(out.report).toEqual({ trackId: 'V3' });
    expect(seq(out.project).videoTracks.map((t) => t.id)).toEqual(['V1', 'V2', 'V3']);
    const p = ap(out.project, 'addTrack', { sequenceId: 'seq_1', kind: 'audio' });
    expect(seq(p).audioTracks.at(-1)!.id).toBe('A3');
  });
  test('updateTrack sets flags; null clears the name', () => {
    let p = ap(baseProject(), 'updateTrack', {
      sequenceId: 'seq_1',
      trackId: 'A2',
      name: 'Music',
      muted: true,
      hidden: true,
      syncLock: false,
      locked: true,
    });
    const t = seq(p).audioTracks[1]!;
    expect([t.name, t.muted, t.hidden, t.syncLock, t.locked]).toEqual([
      'Music',
      true,
      true,
      false,
      true,
    ]);
    p = ap(p, 'updateTrack', { sequenceId: 'seq_1', trackId: 'A2', name: null });
    expect(seq(p).audioTracks[1]).not.toHaveProperty('name');
  });
  test('updateTrack duck: audio tracks only; false clears the flag', () => {
    let p = ap(baseProject(), 'updateTrack', { sequenceId: 'seq_1', trackId: 'A2', duck: true });
    expect(seq(p).audioTracks[1]!.duck).toBe(true);
    expect(seq(p).audioTracks[0]).not.toHaveProperty('duck');
    p = ap(p, 'updateTrack', { sequenceId: 'seq_1', trackId: 'A2', duck: false });
    expect(seq(p).audioTracks[1]).not.toHaveProperty('duck');
    expectCode(
      () => ap(baseProject(), 'updateTrack', { sequenceId: 'seq_1', trackId: 'V1', duck: true }),
      'VALIDATION',
    );
  });
  test('removeTrack: empty only (TRACK_NOT_EMPTY), drops it from caption sources', () => {
    expectCode(
      () => ap(richProject(), 'removeTrack', { sequenceId: 'seq_1', trackId: 'V1' }),
      'TRACK_NOT_EMPTY',
    );
    let p = ap(richProject(), 'setCaptions', { sequenceId: 'seq_1', sourceTrackIds: ['A1', 'A2'] });
    p = ap(p, 'removeTrack', { sequenceId: 'seq_1', trackId: 'A2' });
    expect(seq(p).audioTracks.map((t) => t.id)).toEqual(['A1']);
    expect(seq(p).captions!.sourceTrackIds).toEqual(['A1']);
  });
  test('reorderTracks takes a permutation only', () => {
    const p = ap(richProject(), 'reorderTracks', {
      sequenceId: 'seq_1',
      kind: 'video',
      trackIds: ['V2', 'V1'],
    });
    expect(seq(p).videoTracks.map((t) => t.id)).toEqual(['V2', 'V1']);
    expect(item(p, 'it_s1').trackId).toBe('V2');
    expectCode(
      () =>
        ap(richProject(), 'reorderTracks', {
          sequenceId: 'seq_1',
          kind: 'video',
          trackIds: ['V1'],
        }),
      'VALIDATION',
    );
    expectCode(
      () =>
        ap(richProject(), 'reorderTracks', {
          sequenceId: 'seq_1',
          kind: 'video',
          trackIds: ['V1', 'V1'],
        }),
      'VALIDATION',
    );
  });
});
