// setClipSpeed (engine spec "Clip speed", plan D-62): change a media clip's speed and keep its source
// range, so a slower clip gets longer and a faster one shorter. Linked media clips change with it.
import { z } from 'zod';
import {
  ItemIdSchema,
  SequenceIdSchema,
  SpeedSchema,
  type MediaClip,
  type Project,
  type Sequence,
  type Track,
} from '../model/schema.ts';
import { spanMs, speedOf } from '../model/speed.ts';
import {
  endOf,
  fail,
  findMedia,
  findSeq,
  frameOf,
  LinkRemap,
  linkGroup,
  shiftT,
  snapDown,
  snapT,
  tracksOf,
  type OpContext,
} from './core.ts';
import { cutRange, insertGap } from './timeline.ts';

export const setClipSpeedArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  speed: SpeedSchema,
  unlinked: z.boolean().optional(),
  /** `ripple` shifts later items on the clip's tracks and the sync-locked tracks by the change. */
  onOverlap: z.enum(['error', 'ripple']).default('error'),
});

/** The clip's end at the new speed: same source span, snapped, never past the media end. */
function newEnd(p: Project, s: Sequence, clip: MediaClip, speed: number): number {
  const media = findMedia(p, clip.mediaId);
  if (media.kind === 'image') {
    fail('VALIDATION', `Image clip ${clip.id} has no speed`, 'Speed applies to video and audio', {
      itemId: clip.id,
    });
  }
  let end = snapT(s, clip.startMs + spanMs(clip) / speed);
  if (end <= clip.startMs) end = shiftT(s, clip.startMs, 1);
  if (media.durationMs !== undefined) {
    const limit = snapDown(clip.startMs + (media.durationMs - clip.inMs) / speed, s.canvas.fps);
    if (end > limit) end = limit;
  }
  if (end <= clip.startMs) {
    fail(
      'MEDIA_BOUNDS',
      `Item ${clip.id} has less than one frame of source left at ${speed}×`,
      'Start the clip earlier in the source',
      { itemId: clip.id },
    );
  }
  return end;
}

export function setClipSpeed(
  p: Project,
  a: z.infer<typeof setClipSpeedArgs>,
  ctx: OpContext,
): { durationMs: number } {
  const s = findSeq(p, a.sequenceId);
  const group = linkGroup(s, a.itemId, a.unlinked).filter(
    (g): g is { track: Track; item: MediaClip } => g.item.type === 'media',
  );
  const main = group[0];
  if (!main || main.item.id !== a.itemId) {
    fail(
      'VALIDATION',
      `Item ${a.itemId} is a scene, not a media clip`,
      'Speed applies to media clips',
      {
        itemId: a.itemId,
      },
    );
  }
  const plan = group.map((g) => ({ ...g, end: newEnd(p, s, g.item, a.speed) }));
  const oldEnd = endOf(main.item);
  const frames = frameOf(s, plan[0]!.end) - frameOf(s, oldEnd);
  const mine = new Set(plan.map((g) => g.item.id));
  let applied = false;
  if (a.onOverlap === 'ripple' && frames !== 0) {
    const tracks = new Set<Track>(plan.map((g) => g.track));
    for (const t of tracksOf(s)) if (t.syncLock) tracks.add(t);
    const remap = new LinkRemap(ctx);
    if (frames > 0) insertGap(p, s, [...tracks], oldEnd, frames, remap, ctx);
    else {
      // shorter: apply the new lengths first, so the cut below never touches the clips themselves
      apply(plan, a.speed);
      applied = true;
      const cutFrom = shiftT(s, oldEnd, frames);
      for (const t of tracks) cutRange(p, s, t, cutFrom, oldEnd, remap, ctx);
    }
    remap.finish(s);
  }
  if (!applied) apply(plan, a.speed);
  for (const g of plan) {
    const hit = g.track.items.find(
      (o) => !mine.has(o.id) && o.startMs < endOf(g.item) && endOf(o) > g.item.startMs,
    );
    if (hit) {
      fail(
        'OVERLAP',
        `At ${a.speed}× item ${g.item.id} would overlap ${hit.id} on track ${g.track.id}`,
        "Pass onOverlap: 'ripple' to shift the later items, or make room first",
        { trackId: g.track.id, itemIds: [hit.id, g.item.id] },
      );
    }
  }
  return { durationMs: main.item.durationMs };
}

function apply(plan: { item: MediaClip; end: number }[], speed: number): void {
  for (const g of plan) {
    const old = speedOf(g.item);
    // manual crop pins stay on the same source moment (item-relative timeline ms)
    if (old !== speed && g.item.frame?.keyframes) {
      for (const k of g.item.frame.keyframes) k.atMs = Math.round((k.atMs * old) / speed);
    }
    g.item.durationMs = g.end - g.item.startMs;
    if (speed === 1) delete g.item.speed;
    else g.item.speed = speed;
  }
}
