// Item ops: placeClip, updateClip, moveItem, trimItem, splitItem, removeItem, rippleDelete,
// link, unlink, pasteItems (engine spec "Edit operations", plan D-18).
import { z } from 'zod';
import {
  DenoiseSchema,
  FrameSchema,
  ItemIdSchema,
  ItemSchema,
  MediaIdSchema,
  MotionSchema,
  SequenceIdSchema,
  TrackIdSchema,
  type Item,
  type MediaClip,
  type Project,
  type Sequence,
  type Track,
} from '../model/schema.ts';
import {
  endOf,
  fail,
  findItem,
  findMedia,
  findSeq,
  findTrack,
  frameOf,
  isVideoTrack,
  LinkRemap,
  linkGroup,
  removeFromTrack,
  shiftT,
  snapDown,
  snapIn,
  snapT,
  sortItems,
  tracksOf,
  type OpContext,
} from './core.ts';
import {
  cutRange,
  placeItems,
  shiftItem,
  splitAt,
  trimStartBy,
  type Placement,
} from './timeline.ts';
import { validateVariables } from './templates.ts';

export const OnOverlapSchema = z.enum(['error', 'overwrite', 'insert']);
const time = () => z.int().min(0);

const clipSettings = {
  frame: FrameSchema.optional(),
  motion: MotionSchema.optional(),
  volume: z.number().min(0).max(2).optional(),
  fadeInMs: time().optional(),
  fadeOutMs: time().optional(),
  denoise: DenoiseSchema.optional(),
};

export const placeClipArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  mediaId: MediaIdSchema,
  startMs: time(),
  inMs: time().default(0),
  durationMs: z.int().positive().optional(),
  withAudio: z.boolean().optional(),
  audioTrackId: TrackIdSchema.default('A1'),
  onOverlap: OnOverlapSchema.default('error'),
  ...clipSettings,
});

export const updateClipArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  frame: FrameSchema.nullable().optional(),
  motion: MotionSchema.nullable().optional(),
  volume: z.number().min(0).max(2).nullable().optional(),
  fadeInMs: time().nullable().optional(),
  fadeOutMs: time().nullable().optional(),
  denoise: DenoiseSchema.nullable().optional(),
});

export const moveItemArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  startMs: time().optional(),
  trackId: TrackIdSchema.optional(),
  onOverlap: OnOverlapSchema.default('error'),
  unlinked: z.boolean().optional(),
});

export const trimItemArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  edge: z.enum(['start', 'end']),
  toMs: time(),
  unlinked: z.boolean().optional(),
});

export const splitItemArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  atMs: time(),
  unlinked: z.boolean().optional(),
});

export const removeItemArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  unlinked: z.boolean().optional(),
});

export const rippleDeleteArgs = z
  .strictObject({
    sequenceId: SequenceIdSchema,
    trackId: TrackIdSchema,
    startMs: time(),
    endMs: time(),
  })
  .refine((a) => a.startMs < a.endMs, 'startMs must be before endMs');

export const linkArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemIds: z.array(ItemIdSchema).min(2),
});
export const unlinkArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemIds: z.array(ItemIdSchema).min(1),
});

export const pasteItemsArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  atMs: time(),
  items: z.array(z.strictObject({ trackId: TrackIdSchema, item: ItemSchema })).min(1),
  trackMap: z.record(TrackIdSchema, TrackIdSchema).optional(),
  onOverlap: OnOverlapSchema.default('error'),
});

function mediaOnly(it: Item): MediaClip {
  if (it.type !== 'media')
    fail('VALIDATION', `Item ${it.id} is a scene, not a media clip`, 'Use updateScene for scenes', {
      itemId: it.id,
    });
  return it;
}

export function placeClip(
  p: Project,
  a: z.infer<typeof placeClipArgs>,
  ctx: OpContext,
): { itemIds: string[] } {
  const s = findSeq(p, a.sequenceId);
  const track = findTrack(s, a.trackId);
  const media = findMedia(p, a.mediaId);
  if (media.kind === 'document') {
    fail(
      'TRACK_KIND',
      `Document media ${media.id} cannot be placed`,
      'Documents are reference material only',
      { mediaId: media.id },
    );
  }
  if (a.motion && media.kind !== 'image') {
    fail('VALIDATION', 'motion applies to images only', 'Use frame keyframes for video', {
      mediaId: media.id,
    });
  }
  const start = snapT(s, a.startMs);
  const clip: MediaClip = {
    id: ctx.newId('it_'),
    type: 'media',
    mediaId: media.id,
    startMs: start,
    durationMs: 1,
    inMs: 0,
  };
  clip.inMs = snapIn(p, s, clip, a.inMs);
  let end: number;
  if (a.durationMs !== undefined) end = snapT(s, start + a.durationMs);
  else if (media.durationMs !== undefined && media.kind !== 'image') {
    end = snapDown(start + media.durationMs - clip.inMs, s.canvas.fps);
  } else {
    return fail('VALIDATION', `durationMs is required for ${media.kind} media`, 'Pass durationMs');
  }
  if (end <= start)
    fail('VALIDATION', 'The clip would be shorter than one frame', 'Pass a longer durationMs');
  clip.durationMs = end - start;
  const video = isVideoTrack(track.id);
  if (video) {
    if (a.frame) clip.frame = a.frame;
    if (a.motion) clip.motion = a.motion;
  } else {
    if (a.volume !== undefined) clip.volume = a.volume;
    if (a.fadeInMs !== undefined) clip.fadeInMs = a.fadeInMs;
    if (a.fadeOutMs !== undefined) clip.fadeOutMs = a.fadeOutMs;
    if (a.denoise !== undefined) clip.denoise = a.denoise;
  }
  const placements: Placement[] = [{ track, item: clip }];
  const withAudio = a.withAudio ?? (video && media.kind === 'video' && media.hasAudio === true);
  if (withAudio && video) {
    if (media.kind !== 'video' || !media.hasAudio) {
      fail('VALIDATION', `Media ${media.id} has no sound`, 'Pass withAudio: false', {
        mediaId: media.id,
      });
    }
    const audioTrack = findTrack(s, a.audioTrackId);
    const sound: MediaClip = { ...structuredClone(clip), id: ctx.newId('it_') };
    delete sound.frame;
    if (a.volume !== undefined) sound.volume = a.volume;
    if (a.fadeInMs !== undefined) sound.fadeInMs = a.fadeInMs;
    if (a.fadeOutMs !== undefined) sound.fadeOutMs = a.fadeOutMs;
    if (a.denoise !== undefined) sound.denoise = a.denoise;
    const linkId = ctx.newId('ln_');
    clip.linkId = linkId;
    sound.linkId = linkId;
    placements.push({ track: audioTrack, item: sound });
  }
  placeItems(p, s, placements, a.onOverlap, ctx);
  return { itemIds: placements.map((x) => x.item.id) };
}

export function updateClip(p: Project, a: z.infer<typeof updateClipArgs>): void {
  const s = findSeq(p, a.sequenceId);
  const clip = mediaOnly(findItem(s, a.itemId).item);
  const fields = clip as Record<string, unknown>;
  if (a.motion && p.media.find((m) => m.id === clip.mediaId)?.kind !== 'image') {
    fail('VALIDATION', 'motion applies to images only', 'Use frame keyframes for video', {
      itemId: clip.id,
    });
  }
  for (const k of ['frame', 'motion', 'volume', 'fadeInMs', 'fadeOutMs', 'denoise'] as const) {
    const v = a[k];
    if (v === null) delete fields[k];
    else if (v !== undefined) fields[k] = v;
  }
}

export function moveItem(p: Project, a: z.infer<typeof moveItemArgs>, ctx: OpContext): void {
  const s = findSeq(p, a.sequenceId);
  const group = linkGroup(s, a.itemId, a.unlinked);
  const main = group[0]!;
  const frames =
    a.startMs === undefined ? 0 : frameOf(s, snapT(s, a.startMs)) - frameOf(s, main.item.startMs);
  const dest = a.trackId === undefined ? main.track : findTrack(s, a.trackId);
  const placements: Placement[] = [];
  for (const g of group) {
    removeFromTrack(g.track, g.item.id);
    if (shiftT(s, g.item.startMs, frames) < 0) {
      fail('VALIDATION', `Item ${g.item.id} would start before 0`, 'Move it later', {
        itemId: g.item.id,
      });
    }
    shiftItem(p, s, g.item, frames);
    placements.push({ track: g === main ? dest : g.track, item: g.item });
  }
  placeItems(p, s, placements, a.onOverlap, ctx);
}

export function trimItem(p: Project, a: z.infer<typeof trimItemArgs>): void {
  const s = findSeq(p, a.sequenceId);
  const group = linkGroup(s, a.itemId, a.unlinked);
  const main = group[0]!.item;
  const to = snapT(s, a.toMs);
  const frames = frameOf(s, to) - frameOf(s, a.edge === 'start' ? main.startMs : endOf(main));
  for (const { item } of group) {
    if (a.edge === 'start') trimStartBy(p, s, item, shiftT(s, item.startMs, frames) - item.startMs);
    else item.durationMs = shiftT(s, endOf(item), frames) - item.startMs;
    if (item.durationMs <= 0) {
      fail(
        'VALIDATION',
        `Trimming ${item.id} to ${to} ms leaves nothing`,
        'Use removeItem to delete it',
        { itemId: item.id },
      );
    }
  }
}

export function splitItem(
  p: Project,
  a: z.infer<typeof splitItemArgs>,
  ctx: OpContext,
): { itemIds: string[] } {
  const s = findSeq(p, a.sequenceId);
  const group = linkGroup(s, a.itemId, a.unlinked);
  const at = snapT(s, a.atMs);
  const main = group[0]!.item;
  if (at <= main.startMs || at >= endOf(main)) {
    fail(
      'VALIDATION',
      `${at} ms is not inside item ${main.id}`,
      'Split strictly between its start and end',
      { itemId: main.id },
    );
  }
  const rights: { track: Track; item: Item }[] = [];
  for (const { track, item } of group) {
    if (at <= item.startMs || at >= endOf(item)) continue;
    rights.push({ track, item: splitAt(p, s, item, at, ctx.newId('it_')) });
  }
  const linkId = rights.length > 1 ? ctx.newId('ln_') : undefined;
  for (const r of rights) {
    if (linkId) r.item.linkId = linkId;
    else delete r.item.linkId;
    r.track.items.push(r.item);
    sortItems(r.track);
  }
  return { itemIds: rights.map((r) => r.item.id) };
}

export function removeItem(p: Project, a: z.infer<typeof removeItemArgs>): void {
  const s = findSeq(p, a.sequenceId);
  for (const { track, item } of linkGroup(s, a.itemId, a.unlinked)) removeFromTrack(track, item.id);
}

export function rippleDelete(
  p: Project,
  a: z.infer<typeof rippleDeleteArgs>,
  ctx: OpContext,
): void {
  const s = findSeq(p, a.sequenceId);
  const target = findTrack(s, a.trackId);
  const start = snapT(s, a.startMs);
  const end = snapT(s, a.endMs);
  if (end <= start) return;
  rippleRange(p, s, target, start, end, ctx);
}

/** Cut [start, end) on the track, every sync-locked track and the tracks of linked items; close the gap. */
export function rippleRange(
  p: Project,
  s: Sequence,
  target: Track,
  start: number,
  end: number,
  ctx: OpContext,
): void {
  const tracks = new Set<Track>([target]);
  for (const t of tracksOf(s)) if (t.syncLock) tracks.add(t);
  const links = new Set(
    target.items
      .filter((i) => i.linkId && i.startMs < end && endOf(i) > start)
      .map((i) => i.linkId!),
  );
  for (const t of tracksOf(s))
    if (t.items.some((i) => i.linkId && links.has(i.linkId))) tracks.add(t);
  const remap = new LinkRemap(ctx);
  for (const t of tracks) cutRange(p, s, t, start, end, remap, ctx);
  remap.finish(s);
}

export function link(p: Project, a: z.infer<typeof linkArgs>, ctx: OpContext): { linkId: string } {
  const s = findSeq(p, a.sequenceId);
  const linkId = ctx.newId('ln_');
  for (const id of new Set(a.itemIds)) findItem(s, id).item.linkId = linkId;
  return { linkId };
}

export function unlink(p: Project, a: z.infer<typeof unlinkArgs>): void {
  const s = findSeq(p, a.sequenceId);
  for (const id of a.itemIds) delete findItem(s, id).item.linkId;
}

export function pasteItems(
  p: Project,
  a: z.infer<typeof pasteItemsArgs>,
  ctx: OpContext,
): { itemIds: string[] } {
  const s = findSeq(p, a.sequenceId);
  const at = snapT(s, a.atMs);
  const earliest = Math.min(...a.items.map((x) => x.item.startMs));
  const links = new Map<string, string>();
  const placements: Placement[] = [];
  for (const { trackId, item: src } of a.items) {
    const track = findTrack(s, a.trackMap?.[trackId] ?? trackId);
    const item = structuredClone(src);
    item.id = ctx.newId('it_');
    if (item.linkId) {
      let l = links.get(item.linkId);
      if (!l) links.set(item.linkId, (l = ctx.newId('ln_')));
      item.linkId = l;
    }
    const start = snapT(s, at + (src.startMs - earliest));
    const end = snapT(s, at + (endOf(src) - earliest));
    if (end <= start)
      fail('VALIDATION', `Pasted item ${src.id} is shorter than one frame`, 'Paste longer items');
    item.startMs = start;
    item.durationMs = end - start;
    if (item.type === 'media') item.inMs = snapIn(p, s, item, item.inMs);
    else {
      const t = ctx.templates.get(item.template);
      if (t) validateVariables(t, item.variables, ctx.templates, p);
    }
    placements.push({ track, item });
  }
  placeItems(p, s, placements, a.onOverlap, ctx);
  return { itemIds: placements.map((x) => x.item.id) };
}
