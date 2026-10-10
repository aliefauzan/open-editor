import { describe, expect, test } from 'vitest';
import { ap, clip, expectCode } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

describe('updateClip', () => {
  test('sets frame (auto, stability, trackSpeed, keyframes) and sound settings; null clears', () => {
    let p = ap(richProject(), 'updateClip', {
      sequenceId: 'seq_1',
      itemId: 'it_v2',
      frame: {
        mode: 'auto',
        stability: 'follow',
        trackSpeed: 'fast',
        keyframes: [{ atMs: 0, x: 0.5, y: 0.5, scale: 1 }],
      },
    });
    expect(clip(p, 'it_v2').frame).toEqual({
      mode: 'auto',
      stability: 'follow',
      trackSpeed: 'fast',
      keyframes: [{ atMs: 0, x: 0.5, y: 0.5, scale: 1 }],
    });
    p = ap(p, 'updateClip', {
      sequenceId: 'seq_1',
      itemId: 'it_a2',
      volume: 1.5,
      fadeInMs: 200,
      fadeOutMs: 300,
      denoise: 'strong',
    });
    expect(clip(p, 'it_a2')).toMatchObject({
      volume: 1.5,
      fadeInMs: 200,
      fadeOutMs: 300,
      denoise: 'strong',
    });
    p = ap(p, 'updateClip', { sequenceId: 'seq_1', itemId: 'it_a2', volume: null, denoise: null });
    expect(clip(p, 'it_a2')).not.toHaveProperty('volume');
    expect(clip(p, 'it_a2')).not.toHaveProperty('denoise');
  });
  test('invalid values fail VALIDATION', () => {
    const bad = [
      { frame: { mode: 'wobble' } },
      { frame: { mode: 'auto', stability: 'shaky' } },
      { frame: { mode: 'auto', trackSpeed: 'warp' } },
      { frame: { mode: 'auto', keyframes: [{ atMs: 0, x: 0, y: 0, scale: 0 }] } },
      { volume: 3 },
      { denoise: 'max' },
      { fadeInMs: -1 },
    ];
    for (const b of bad)
      expectCode(
        () => ap(richProject(), 'updateClip', { sequenceId: 'seq_1', itemId: 'it_v1', ...b }),
        'VALIDATION',
      );
  });
  test('scenes are not media clips', () => {
    expectCode(
      () => ap(richProject(), 'updateClip', { sequenceId: 'seq_1', itemId: 'it_s1', volume: 1 }),
      'VALIDATION',
    );
  });
});
