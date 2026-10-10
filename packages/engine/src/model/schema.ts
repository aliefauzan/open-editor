// project.json and transcript schemas (engine spec "Data model", "Transcripts"; plan D-15, D-18).
// Strict objects: load rejects unknown fields, so a new field needs a schemaVersion bump + migration.
import { z } from 'zod';
import { checkRelativePath } from '../paths.ts';
import { VoxError } from '../errors.ts';
import { isFpsInSet } from './fps.ts';

export const SCHEMA_VERSION = 2;

const int = () => z.int();
const nonNeg = () => z.int().min(0);
const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`), `id must start with ${prefix}`);
const relPath = () =>
  z
    .string()
    .refine(
      checkRelativePath,
      'path must be relative to the project folder (no .., NUL or absolute)',
    );

export const FpsSchema = z.strictObject({ num: z.int().positive(), den: z.int().positive() });
export const CanvasFpsSchema = FpsSchema.refine(
  isFpsInSet,
  'canvas fps must be one of 24/1, 25/1, 30/1, 60/1, 24000/1001, 30000/1001, 60000/1001',
);

export const MediaIdSchema = id('m_');
export const SequenceIdSchema = id('seq_');
export const ItemIdSchema = id('it_');
export const LinkIdSchema = id('ln_');
export const VideoTrackIdSchema = z.string().regex(/^V[1-9][0-9]*$/, 'video track ids are V1..Vn');
export const AudioTrackIdSchema = z.string().regex(/^A[1-9][0-9]*$/, 'audio track ids are A1..An');
export const TrackIdSchema = z
  .string()
  .regex(/^[VA][1-9][0-9]*$/, 'track ids are V1..Vn or A1..An');
export const TemplateIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/, 'template ids are <styleId>/<name>');
export const WordKeySchema = z
  .string()
  .regex(/^m_[A-Za-z0-9_-]+:[^:\s]+:\d+$/, 'wordKey is <mediaId>:<transcriptRev>:<wordIndex>');

export const MediaKindSchema = z.enum(['video', 'audio', 'image', 'document']);

export const MediaItemSchema = z.strictObject({
  id: MediaIdSchema,
  kind: MediaKindSchema,
  path: relPath(),
  proxyPath: relPath().optional(),
  audioPath: relPath().optional(),
  thumbsPath: relPath().optional(),
  peaksPath: relPath().optional(),
  textPath: relPath().optional(),
  durationMs: z.int().positive().optional(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  hasAudio: z.boolean().optional(),
  fps: FpsSchema.optional(),
  vfr: z.boolean().optional(),
  cfrPath: relPath().optional(),
  loudness: z.strictObject({ integratedLufs: z.number(), truePeakDb: z.number() }).optional(),
  shotsPath: relPath().optional(),
  origin: z.strictObject({
    type: z.enum(['url', 'upload', 'archive', 'generated']),
    url: z.string().optional(),
    license: z.string().optional(),
    licenseUrl: z.string().optional(),
    author: z.string().optional(),
    attribution: z.string().optional(),
    prompt: z.string().optional(),
  }),
  transcriptPath: relPath().optional(),
  transcriptRev: z
    .string()
    .regex(/^[^:\s]+$/)
    .optional(),
  facetrackPath: relPath().optional(),
  tags: z.array(z.string()),
  description: z.string().optional(),
});

export const KeyframeSchema = z.strictObject({
  atMs: int(),
  x: z.number(),
  y: z.number(),
  scale: z.number().positive(),
});

export const FrameSchema = z.strictObject({
  mode: z.enum(['cover', 'contain', 'facetrack', 'auto', 'manual']),
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().positive().optional(),
  faceIndex: nonNeg().optional(),
  stability: z.enum(['locked', 'smooth', 'follow']).optional(),
  trackSpeed: z.enum(['slow', 'normal', 'fast']).optional(),
  keyframes: z.array(KeyframeSchema).optional(),
});

export const MotionSchema = z.strictObject({
  type: z.enum(['none', 'push-in', 'pan']),
  amount: z.number(),
});
export const DenoiseSchema = z.enum(['off', 'light', 'strong']);
export const TransitionInSchema = z.strictObject({
  template: TemplateIdSchema,
  durationMs: z.int().positive(),
});

const itemBase = {
  id: ItemIdSchema,
  startMs: nonNeg(),
  durationMs: z.int().positive(),
  linkId: LinkIdSchema.optional(),
  transitionIn: TransitionInSchema.optional(),
};

export const MediaClipSchema = z.strictObject({
  ...itemBase,
  type: z.literal('media'),
  mediaId: MediaIdSchema,
  inMs: nonNeg(),
  frame: FrameSchema.optional(),
  motion: MotionSchema.optional(),
  volume: z.number().min(0).max(2).optional(),
  fadeInMs: nonNeg().optional(),
  fadeOutMs: nonNeg().optional(),
  denoise: DenoiseSchema.optional(),
});

export const SceneClipSchema = z.strictObject({
  ...itemBase,
  type: z.literal('scene'),
  template: TemplateIdSchema,
  templateVersion: z.string().regex(/^\d+\.\d+\.\d+([-+].*)?$/, 'templateVersion is a semver'),
  variables: z.record(z.string(), z.unknown()),
  sfxOff: z.array(z.string()).optional(),
});

export const ItemSchema = z.discriminatedUnion('type', [MediaClipSchema, SceneClipSchema]);

const trackFields = {
  name: z.string().optional(),
  locked: z.boolean(),
  hidden: z.boolean(),
  muted: z.boolean(),
  syncLock: z.boolean(),
  items: z.array(ItemSchema),
};
export const VideoTrackSchema = z.strictObject({ id: VideoTrackIdSchema, ...trackFields });
export const AudioTrackSchema = z.strictObject({ id: AudioTrackIdSchema, ...trackFields });
export const TrackSchema = z.strictObject({ id: TrackIdSchema, ...trackFields });

export const CaptionOverrideSchema = z
  .strictObject({
    wordKey: WordKeySchema,
    text: z.string().nullable().optional(),
    breakAfter: z.boolean().optional(),
    startMs: nonNeg().optional(),
    endMs: nonNeg().optional(),
    emphasis: z.boolean().optional(),
  })
  .refine(
    (o) => o.startMs === undefined || o.endMs === undefined || o.startMs < o.endMs,
    'startMs must be before endMs',
  );

export const CaptionTrackSchema = z.strictObject({
  enabled: z.boolean(),
  sourceTrackIds: z.array(AudioTrackIdSchema),
  preset: TemplateIdSchema,
  maxWords: z.int().min(1),
  maxLines: z.int().min(1),
  maxCharsPerLine: z.int().min(1),
  gapFillMs: nonNeg(),
  autoEmphasis: z.boolean().optional(),
  position: z.strictObject({ yPct: z.number().min(0).max(100) }),
  overrides: z.array(CaptionOverrideSchema),
});

export const CanvasSchema = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
  fps: CanvasFpsSchema,
});

export const SequenceSchema = z.strictObject({
  id: SequenceIdSchema,
  name: z.string(),
  canvas: CanvasSchema,
  styleId: z.string().min(1),
  videoTracks: z.array(VideoTrackSchema),
  audioTracks: z.array(AudioTrackSchema),
  captions: CaptionTrackSchema.nullable(),
  sfx: z.boolean(),
  overlays: z.array(z.string()).optional(),
  sourceRange: z
    .strictObject({ mediaId: MediaIdSchema, inMs: nonNeg(), outMs: nonNeg() })
    .refine((r) => r.outMs > r.inMs, 'outMs must be after inMs')
    .optional(),
});

export const ProjectSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().regex(/^p_[a-z0-9]+$/, 'project ids are p_<lowercase base-36>'),
    name: z.string(),
    version: nonNeg(),
    media: z.array(MediaItemSchema),
    sequences: z.array(SequenceSchema),
    meta: z.strictObject({
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      sourceUrls: z.array(z.string()),
    }),
  })
  .superRefine((p, ctx) => {
    const dup = (what: string, ids: string[]) => {
      const seen = new Set<string>();
      for (const i of ids) {
        if (seen.has(i)) ctx.addIssue({ code: 'custom', message: `duplicate ${what} id ${i}` });
        seen.add(i);
      }
    };
    dup(
      'media',
      p.media.map((m) => m.id),
    );
    dup(
      'sequence',
      p.sequences.map((s) => s.id),
    );
    dup(
      'item',
      p.sequences.flatMap((s) =>
        [...s.videoTracks, ...s.audioTracks].flatMap((t) => t.items.map((i) => i.id)),
      ),
    );
    for (const s of p.sequences)
      dup(
        `track (${s.id})`,
        [...s.videoTracks, ...s.audioTracks].map((t) => t.id),
      );
  });

export const TranscriptWordSchema = z
  .strictObject({
    text: z.string(),
    startMs: nonNeg(),
    endMs: nonNeg(),
    kind: z.enum(['word', 'pause', 'repeat', 'filler']),
  })
  .refine((w) => w.endMs >= w.startMs, 'endMs must not be before startMs');

export const TranscriptSchema = z.strictObject({
  language: z.string(),
  words: z.array(TranscriptWordSchema),
  speechRegions: z.array(
    z
      .strictObject({ startMs: nonNeg(), endMs: nonNeg() })
      .refine((r) => r.endMs >= r.startMs, 'endMs must not be before startMs'),
  ),
});

export type Fps = z.infer<typeof FpsSchema>;
export type MediaItem = z.infer<typeof MediaItemSchema>;
export type MediaKind = z.infer<typeof MediaKindSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type MediaClip = z.infer<typeof MediaClipSchema>;
export type SceneClip = z.infer<typeof SceneClipSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type CaptionOverride = z.infer<typeof CaptionOverrideSchema>;
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;
export type Sequence = z.infer<typeof SequenceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type WordKind = TranscriptWord['kind'];

export function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Validate a whole project (load and after every op). Throws VoxError VALIDATION. */
export function parseProject(value: unknown): Project {
  const r = ProjectSchema.safeParse(value);
  if (!r.success) {
    throw new VoxError(
      'VALIDATION',
      `project.json is invalid: ${formatIssues(r.error)}`,
      'Fix the listed fields; unknown fields need a newer schemaVersion',
      {
        details: {
          issues: r.error.issues
            .slice(0, 20)
            .map((i) => ({ path: i.path.map(String), message: i.message })),
        },
      },
    );
  }
  return r.data;
}
