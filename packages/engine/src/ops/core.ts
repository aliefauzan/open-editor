// Shared op plumbing: context, lookups, errors and frame-grid helpers (engine spec "Edit operations").
import { VoxError, type ErrorCode } from '../errors.ts';
import { frame, ms, snap, snapToSource } from '../model/fps.ts';
import type { IdPrefix } from '../model/ids.ts';
import type {
  Fps,
  Item,
  MediaClip,
  MediaItem,
  Project,
  Sequence,
  Track,
  Transcript,
} from '../model/schema.ts';
import type { TemplateLookup } from './templates.ts';

export interface OpContext {
  templates: TemplateLookup;
  newId(prefix: IdPrefix): string;
  /** The parsed transcript of a media item, if it has one (removePauses, removeWords). */
  transcript(media: MediaItem): Transcript | undefined;
  /** A named snapshot (restoreSnapshot). */
  snapshot(name: string): Project | undefined;
}

export function fail(
  code: ErrorCode,
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): never {
  throw new VoxError(code, message, hint, details === undefined ? {} : { details });
}

export function findSeq(p: Project, sequenceId: string): Sequence {
  const s = p.sequences.find((x) => x.id === sequenceId);
  if (!s)
    fail('NOT_FOUND', `Sequence ${sequenceId} not found`, 'Use a sequence id from the project', {
      sequenceId,
    });
  return s;
}

export function tracksOf(s: Sequence): Track[] {
  return [...s.videoTracks, ...s.audioTracks];
}

export function findTrack(s: Sequence, trackId: string): Track {
  const t = tracksOf(s).find((x) => x.id === trackId);
  if (!t)
    fail('NOT_FOUND', `Track ${trackId} not found in ${s.id}`, 'Use a track id like V1 or A1', {
      trackId,
    });
  return t;
}

export function isVideoTrack(trackId: string): boolean {
  return trackId.startsWith('V');
}

export interface Located {
  track: Track;
  item: Item;
}

export function findItem(s: Sequence, itemId: string): Located {
  for (const track of tracksOf(s)) {
    const item = track.items.find((i) => i.id === itemId);
    if (item) return { track, item };
  }
  return fail(
    'NOT_FOUND',
    `Item ${itemId} not found in ${s.id}`,
    'Use an item id from the sequence',
    { itemId },
  );
}

/** The item plus every item sharing its linkId (the item first), unless `unlinked`. */
export function linkGroup(s: Sequence, itemId: string, unlinked = false): Located[] {
  const main = findItem(s, itemId);
  const group: Located[] = [main];
  if (unlinked || !main.item.linkId) return group;
  for (const track of tracksOf(s)) {
    for (const item of track.items) {
      if (item.id !== itemId && item.linkId === main.item.linkId) group.push({ track, item });
    }
  }
  return group;
}

export function findMedia(p: Project, mediaId: string): MediaItem {
  const m = p.media.find((x) => x.id === mediaId);
  if (!m)
    fail('NOT_FOUND', `Media ${mediaId} not found`, 'Use a media id from the library', { mediaId });
  return m;
}

export const endOf = (i: { startMs: number; durationMs: number }): number =>
  i.startMs + i.durationMs;

export function seqFps(s: Sequence): Fps {
  return s.canvas.fps;
}

export function snapT(s: Sequence, t: number): number {
  return snap(t, s.canvas.fps);
}

/** Largest grid time at or before `t`. */
export function snapDown(t: number, fps: Fps): number {
  const f = Math.floor((t * fps.num) / (1000 * fps.den));
  let v = ms(f, fps);
  if (v > t) v = ms(f - 1, fps);
  return v;
}

/** Source grid of a clip's media: the media's own fps, else the sequence grid. */
export function sourceFps(p: Project, s: Sequence, clip: MediaClip): Fps {
  return p.media.find((m) => m.id === clip.mediaId)?.fps ?? s.canvas.fps;
}

export function snapIn(p: Project, s: Sequence, clip: MediaClip, inMs: number): number {
  const media = p.media.find((m) => m.id === clip.mediaId);
  if (media?.kind === 'image') return 0;
  return snapToSource(inMs, media?.fps, s.canvas.fps);
}

export function onGrid(t: number, fps: Fps): boolean {
  return ms(frame(t, fps), fps) === t;
}

export function sortItems(t: Track): void {
  t.items.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sortProject(p: Project): void {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  p.media.sort(byId);
  p.sequences.sort(byId);
  for (const s of p.sequences) for (const t of tracksOf(s)) sortItems(t);
}

export function removeFromTrack(t: Track, itemId: string): void {
  t.items = t.items.filter((i) => i.id !== itemId);
}

/** Per-op map from an old linkId to the new linkId shared by the right parts of a split. */
export class LinkRemap {
  private readonly map = new Map<string, string>();
  private readonly ctx: OpContext;
  constructor(ctx: OpContext) {
    this.ctx = ctx;
  }
  get(old: string): string {
    let v = this.map.get(old);
    if (!v) {
      v = this.ctx.newId('ln_');
      this.map.set(old, v);
    }
    return v;
  }
  /** Drop new linkIds that ended up on a single item. */
  finish(s: Sequence): void {
    for (const id of this.map.values()) {
      const users = tracksOf(s).flatMap((t) => t.items.filter((i) => i.linkId === id));
      if (users.length === 1) delete users[0]!.linkId;
    }
  }
}

export function overlapError(track: Track, a: Item, b: Item): never {
  return fail(
    'OVERLAP',
    `Item ${b.id} overlaps ${a.id} on track ${track.id}`,
    "Pick a free time, or pass onOverlap: 'overwrite' or 'insert'",
    { trackId: track.id, itemIds: [a.id, b.id] },
  );
}

/** Frame index of a time on the sequence grid. */
export function frameOf(s: Sequence, t: number): number {
  return frame(t, s.canvas.fps);
}

/**
 * Shift a grid time by whole frames. Shifting must happen in frame space: at rates like 24 or
 * 29.97 fps, grid ms values are rounded, so `t + (b - a)` can land between frames.
 */
export function shiftT(s: Sequence, t: number, frames: number): number {
  return ms(frameOf(s, t) + frames, s.canvas.fps);
}
