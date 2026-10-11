// Sequence and track ops (engine spec "Edit operations", plan D-18).
import { z } from 'zod';
import { DEFAULT_FPS, frame, ms, snap } from '../model/fps.ts';
import {
  CanvasFpsSchema,
  MediaIdSchema,
  SequenceIdSchema,
  TrackIdSchema,
  type Fps,
  type Project,
  type Sequence,
  type Track,
} from '../model/schema.ts';
import { spanMs, speedOf } from '../model/speed.ts';
import { endOf, fail, findSeq, findTrack, snapDown, tracksOf, type OpContext } from './core.ts';

const name = () => z.string().min(1).max(200);

export const CanvasPatchSchema = z.strictObject({
  width: z.int().positive().max(8192).optional(),
  height: z.int().positive().max(8192).optional(),
  fps: CanvasFpsSchema.optional(),
});

export const addSequenceArgs = z.strictObject({
  name: name(),
  id: SequenceIdSchema.optional(),
  canvas: CanvasPatchSchema.optional(),
  styleId: z.string().min(1).optional(),
});

export const updateSequenceArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  name: name().optional(),
  canvas: CanvasPatchSchema.optional(),
  styleId: z.string().min(1).optional(),
  sfx: z.boolean().optional(),
  overlays: z.array(z.string().min(1)).nullable().optional(),
  sourceRange: z
    .strictObject({ mediaId: MediaIdSchema, inMs: z.int().min(0), outMs: z.int().min(0) })
    .refine((r) => r.inMs < r.outMs, 'sourceRange.inMs must be before outMs')
    .nullable()
    .optional(),
});

export const duplicateSequenceArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  name: name().optional(),
});
export const removeSequenceArgs = z.strictObject({ sequenceId: SequenceIdSchema });

export const addTrackArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  kind: z.enum(['video', 'audio']),
  name: name().optional(),
});
export const updateTrackArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  name: name().nullable().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  muted: z.boolean().optional(),
  syncLock: z.boolean().optional(),
});
export const removeTrackArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
});
export const reorderTracksArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  kind: z.enum(['video', 'audio']),
  trackIds: z.array(TrackIdSchema).min(1),
});

const emptyTrack = (id: string): Track => ({
  id,
  locked: false,
  hidden: false,
  muted: false,
  syncLock: true,
  items: [],
});

export function addSequence(
  p: Project,
  a: z.infer<typeof addSequenceArgs>,
  ctx: OpContext,
): { sequenceId: string } {
  const id = a.id ?? ctx.newId('seq_');
  if (p.sequences.some((s) => s.id === id)) {
    fail('VALIDATION', `Sequence ${id} already exists`, 'Pick a new sequence id', {
      sequenceId: id,
    });
  }
  p.sequences.push({
    id,
    name: a.name,
    canvas: {
      width: a.canvas?.width ?? 1080,
      height: a.canvas?.height ?? 1920,
      fps: a.canvas?.fps ?? { ...DEFAULT_FPS },
    },
    styleId: a.styleId ?? 'base',
    videoTracks: [emptyTrack('V1'), emptyTrack('V2')],
    audioTracks: [emptyTrack('A1'), emptyTrack('A2')],
    captions: null,
    sfx: true,
  });
  return { sequenceId: id };
}

/** Re-snap every item of a sequence to a new frame grid (fps change; one history entry). */
function resnap(p: Project, s: Sequence, fps: Fps): void {
  for (const t of tracksOf(s)) {
    for (const it of t.items) {
      const start = snap(it.startMs, fps);
      let end = snap(endOf(it), fps);
      if (end <= start) end = ms(frame(start, fps) + 1, fps);
      it.startMs = start;
      it.durationMs = end - start;
      if (it.type !== 'media') continue;
      const media = p.media.find((m) => m.id === it.mediaId);
      if (!media || media.kind === 'image') continue;
      if (!media.fps) it.inMs = snap(it.inMs, fps);
      if (media.durationMs !== undefined && it.inMs + spanMs(it) > media.durationMs) {
        it.durationMs = snapDown(start + (media.durationMs - it.inMs) / speedOf(it), fps) - start;
      }
    }
  }
}

export function updateSequence(p: Project, a: z.infer<typeof updateSequenceArgs>): void {
  const s = findSeq(p, a.sequenceId);
  if (a.name !== undefined) s.name = a.name;
  if (a.styleId !== undefined) s.styleId = a.styleId;
  if (a.sfx !== undefined) s.sfx = a.sfx;
  if (a.overlays === null) delete s.overlays;
  else if (a.overlays !== undefined) s.overlays = a.overlays;
  if (a.sourceRange === null) delete s.sourceRange;
  else if (a.sourceRange !== undefined) {
    if (!p.media.some((m) => m.id === a.sourceRange!.mediaId)) {
      fail(
        'NOT_FOUND',
        `Media ${a.sourceRange.mediaId} not found`,
        'Use a media id from the library',
      );
    }
    s.sourceRange = a.sourceRange;
  }
  if (a.canvas) {
    const fps = a.canvas.fps;
    if (fps && (fps.num !== s.canvas.fps.num || fps.den !== s.canvas.fps.den)) resnap(p, s, fps);
    s.canvas = { ...s.canvas, ...a.canvas };
  }
}

export function duplicateSequence(
  p: Project,
  a: z.infer<typeof duplicateSequenceArgs>,
  ctx: OpContext,
): { sequenceId: string } {
  const src = findSeq(p, a.sequenceId);
  const copy = structuredClone(src);
  copy.id = ctx.newId('seq_');
  copy.name = a.name ?? `${src.name} copy`;
  const links = new Map<string, string>();
  for (const t of tracksOf(copy)) {
    for (const it of t.items) {
      it.id = ctx.newId('it_');
      if (it.linkId) {
        let l = links.get(it.linkId);
        if (!l) links.set(it.linkId, (l = ctx.newId('ln_')));
        it.linkId = l;
      }
    }
  }
  p.sequences.push(copy);
  return { sequenceId: copy.id };
}

export function removeSequence(p: Project, a: z.infer<typeof removeSequenceArgs>): void {
  findSeq(p, a.sequenceId);
  p.sequences = p.sequences.filter((s) => s.id !== a.sequenceId);
}

export function addTrack(p: Project, a: z.infer<typeof addTrackArgs>): { trackId: string } {
  const s = findSeq(p, a.sequenceId);
  const list = a.kind === 'video' ? s.videoTracks : s.audioTracks;
  const letter = a.kind === 'video' ? 'V' : 'A';
  const n = Math.max(0, ...list.map((t) => Number(t.id.slice(1)))) + 1;
  const t = emptyTrack(`${letter}${n}`);
  if (a.name !== undefined) t.name = a.name;
  list.push(t);
  return { trackId: t.id };
}

export function updateTrack(p: Project, a: z.infer<typeof updateTrackArgs>): void {
  const t = findTrack(findSeq(p, a.sequenceId), a.trackId);
  if (a.name === null) delete t.name;
  else if (a.name !== undefined) t.name = a.name;
  if (a.locked !== undefined) t.locked = a.locked;
  if (a.hidden !== undefined) t.hidden = a.hidden;
  if (a.muted !== undefined) t.muted = a.muted;
  if (a.syncLock !== undefined) t.syncLock = a.syncLock;
}

export function removeTrack(p: Project, a: z.infer<typeof removeTrackArgs>): void {
  const s = findSeq(p, a.sequenceId);
  const t = findTrack(s, a.trackId);
  if (t.items.length > 0) {
    fail(
      'TRACK_NOT_EMPTY',
      `Track ${t.id} still has ${t.items.length} item(s)`,
      'Remove its items first',
      {
        trackId: t.id,
      },
    );
  }
  s.videoTracks = s.videoTracks.filter((x) => x.id !== t.id);
  s.audioTracks = s.audioTracks.filter((x) => x.id !== t.id);
  if (s.captions) s.captions.sourceTrackIds = s.captions.sourceTrackIds.filter((x) => x !== t.id);
}

export function reorderTracks(p: Project, a: z.infer<typeof reorderTracksArgs>): void {
  const s = findSeq(p, a.sequenceId);
  const list = a.kind === 'video' ? s.videoTracks : s.audioTracks;
  const ids = list.map((t) => t.id);
  const ok =
    a.trackIds.length === ids.length &&
    new Set(a.trackIds).size === ids.length &&
    a.trackIds.every((x) => ids.includes(x));
  if (!ok) {
    fail(
      'VALIDATION',
      `trackIds must be a permutation of ${ids.join(', ')}`,
      'List every track of that kind once',
    );
  }
  const sorted = a.trackIds.map((id) => list.find((t) => t.id === id)!);
  if (a.kind === 'video') s.videoTracks = sorted as Sequence['videoTracks'];
  else s.audioTracks = sorted as Sequence['audioTracks'];
}
