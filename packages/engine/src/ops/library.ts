// Library ops: addMedia, updateMedia, removeMedia, replaceMedia (engine spec "Edit operations").
// removeMedia removes the library entry only; files on disk are never deleted (R4 S22).
import { z } from 'zod';
import { snapToSource } from '../model/fps.ts';
import { MediaIdSchema, MediaItemSchema, type MediaItem, type Project } from '../model/schema.ts';
import { spanMs, speedOf } from '../model/speed.ts';
import { endOf, fail, findMedia, snapDown, tracksOf } from './core.ts';

export const addMediaArgs = z.strictObject({ media: MediaItemSchema });

type MediaPatch = { [K in keyof Omit<MediaItem, 'id' | 'kind'>]?: MediaItem[K] | null };

const patchShape: Record<string, z.ZodType> = {};
for (const [k, v] of Object.entries(MediaItemSchema.shape)) {
  if (k === 'id' || k === 'kind') continue;
  patchShape[k] = v instanceof z.ZodOptional ? v.unwrap().nullable().optional() : v.optional();
}
export const MediaPatchSchema = z.strictObject(patchShape) as unknown as z.ZodType<MediaPatch>;

export const updateMediaArgs = z.strictObject({ mediaId: MediaIdSchema, patch: MediaPatchSchema });
export const removeMediaArgs = z.strictObject({ mediaId: MediaIdSchema });
export const replaceMediaArgs = z.strictObject({
  mediaId: MediaIdSchema,
  withMediaId: MediaIdSchema,
});

export function addMedia(p: Project, a: z.infer<typeof addMediaArgs>): void {
  if (p.media.some((m) => m.id === a.media.id)) {
    fail('VALIDATION', `Media ${a.media.id} already exists`, 'Pick a new media id', {
      mediaId: a.media.id,
    });
  }
  p.media.push(a.media);
}

export function updateMedia(p: Project, a: z.infer<typeof updateMediaArgs>): void {
  const m = findMedia(p, a.mediaId) as Record<string, unknown>;
  for (const [k, v] of Object.entries(a.patch)) {
    if (v === null) delete m[k];
    else if (v !== undefined) m[k] = v;
  }
}

/** Item ids (and other references) that use a media item. */
export function mediaUsers(p: Project, mediaId: string): string[] {
  const users: string[] = [];
  const needle = JSON.stringify(mediaId);
  for (const s of p.sequences) {
    if (s.sourceRange?.mediaId === mediaId) users.push(`${s.id}.sourceRange`);
    for (const t of tracksOf(s)) {
      for (const it of t.items) {
        if (it.type === 'media' && it.mediaId === mediaId) users.push(it.id);
        else if (it.type === 'scene' && JSON.stringify(it.variables).includes(needle))
          users.push(it.id);
      }
    }
  }
  return users;
}

export function removeMedia(p: Project, a: z.infer<typeof removeMediaArgs>): void {
  findMedia(p, a.mediaId);
  const users = mediaUsers(p, a.mediaId);
  if (users.length > 0) {
    fail(
      'MEDIA_IN_USE',
      `Media ${a.mediaId} is used by ${users.join(', ')}`,
      'Remove or replace those clips first',
      {
        mediaId: a.mediaId,
        itemIds: users,
      },
    );
  }
  p.media = p.media.filter((m) => m.id !== a.mediaId);
}

export function replaceMedia(
  p: Project,
  a: z.infer<typeof replaceMediaArgs>,
): { clamped: string[] } {
  const from = findMedia(p, a.mediaId);
  const to = findMedia(p, a.withMediaId);
  if (from.kind !== to.kind) {
    fail(
      'VALIDATION',
      `Cannot replace ${from.kind} media with ${to.kind} media`,
      'Pick media of the same kind',
      {
        mediaId: a.mediaId,
        withMediaId: a.withMediaId,
      },
    );
  }
  const clamped: string[] = [];
  for (const s of p.sequences) {
    if (s.sourceRange?.mediaId === from.id) s.sourceRange.mediaId = to.id;
    for (const t of tracksOf(s)) {
      for (const it of t.items) {
        if (it.type !== 'media' || it.mediaId !== from.id) continue;
        it.mediaId = to.id;
        if (to.kind === 'image') {
          delete it.speed; // images have no source time (plan D-62)
          continue;
        }
        it.inMs = snapToSource(it.inMs, to.fps, s.canvas.fps);
        const limit = to.durationMs;
        if (limit === undefined || it.inMs + spanMs(it) <= limit) continue;
        if (it.inMs >= limit) it.inMs = 0;
        const end = snapDown(it.startMs + (limit - it.inMs) / speedOf(it), s.canvas.fps);
        if (end < endOf(it)) it.durationMs = end - it.startMs;
        if (it.durationMs <= 0) {
          fail(
            'MEDIA_BOUNDS',
            `Media ${to.id} is too short for item ${it.id}`,
            'Pick longer media',
            { itemId: it.id },
          );
        }
        clamped.push(it.id);
      }
    }
  }
  return { clamped: clamped.sort() };
}
