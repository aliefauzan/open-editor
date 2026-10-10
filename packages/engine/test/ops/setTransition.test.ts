import { describe, expect, test } from 'vitest';
import { ap, clip, expectCode } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

const setT = (args: Record<string, unknown>, p = richProject()) =>
  ap(p, 'setTransition', { sequenceId: 'seq_1', itemId: 'it_v2', ...args });

describe('setTransition', () => {
  test('sets and clears transitionIn', () => {
    let p = setT({ transition: { template: 'test/crossfade', durationMs: 500 } });
    expect(clip(p, 'it_v2').transitionIn).toEqual({ template: 'test/crossfade', durationMs: 500 });
    p = setT({ transition: null }, p);
    expect(clip(p, 'it_v2')).not.toHaveProperty('transitionIn');
  });
  test('blending transitions need handles on both sides (NO_HANDLES)', () => {
    // it_v1 starts at source 0 → no incoming handle
    expectCode(
      () =>
        ap(richProject(), 'setTransition', {
          sequenceId: 'seq_1',
          itemId: 'it_v1',
          transition: { template: 'test/crossfade', durationMs: 500 },
        }),
      'NO_HANDLES',
    );
    // outgoing it_v1 ends at source 5000 of 20000 and it_v2 starts at 8008: fine
    expect(() =>
      setT({ transition: { template: 'test/crossfade', durationMs: 2000 } }),
    ).not.toThrow();
    // outgoing clip ending at the media end has no handle
    let p = ap(richProject(), 'removeItem', { sequenceId: 'seq_1', itemId: 'it_v2' });
    p = ap(p, 'placeClip', {
      sequenceId: 'seq_1',
      trackId: 'V1',
      mediaId: 'm_video',
      startMs: 5000,
      inMs: 17017,
      withAudio: false,
    });
    p = ap(p, 'placeClip', {
      sequenceId: 'seq_1',
      trackId: 'V1',
      mediaId: 'm_video',
      startMs: 7966,
      inMs: 5005,
      durationMs: 1000,
      withAudio: false,
      onOverlap: 'overwrite',
    });
    const last = p.sequences[0]!.videoTracks[0]!.items.at(-1)!;
    expectCode(
      () =>
        ap(p, 'setTransition', {
          sequenceId: 'seq_1',
          itemId: last.id,
          transition: { template: 'test/crossfade', durationMs: 500 },
        }),
      'NO_HANDLES',
    );
  });
  test('cover-style transitions need no handles', () => {
    expect(() =>
      ap(richProject(), 'setTransition', {
        sequenceId: 'seq_1',
        itemId: 'it_v1',
        transition: { template: 'test/wipe', durationMs: 500 },
      }),
    ).not.toThrow();
  });
  test('template must be a known transition; duration within bounds', () => {
    expectCode(
      () => setT({ transition: { template: 'test/title', durationMs: 500 } }),
      'TEMPLATE_UNKNOWN',
    );
    expectCode(
      () => setT({ transition: { template: 'test/nope', durationMs: 500 } }),
      'TEMPLATE_UNKNOWN',
    );
    expectCode(
      () => setT({ transition: { template: 'test/wipe', durationMs: 3000 } }),
      'DURATION_BOUNDS',
    );
  });
});
