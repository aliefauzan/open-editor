// Media jobs and reads behind `openEngine` (engine spec "Library API" → jobs, ingest, transcribe,
// shots, facetrack, mediaFrames; plan phase 04, D-15). Each job that writes to the model records
// the project version as `baseVersion` when it starts and applies its result as one `batch` with its
// `jobId`, so a user edit to the same media item while it runs fails it with JOB_CONFLICT.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.ts';
import { VoxError } from './errors.ts';
import { writeAtomic } from './history/files.ts';
import type { ProjectStore } from './history/store.ts';
import { ACTORS, type Actor } from './history/types.ts';
import type { JobContext, JobRunner } from './jobs.ts';
import { MediaIdSchema, type MediaItem, type Project } from './model/schema.ts';
import type { Resolver } from './net/address.ts';
import { fetchPublic } from './net/fetch.ts';
import type { Dial } from './net/proxy.ts';
import { withRetry } from './net/retry.ts';
import type { OpCall } from './ops/index.ts';
import { resolveProjectPath } from './paths.ts';
import { repoPyProject, runPyTool, type PyBridgeOptions } from './py.ts';
import type { Redactor } from './redact.ts';
import { frameCards, type FrameCard } from './stages/framecard.ts';
import {
  HighlightsSchema,
  highlightsTimeoutMs,
  runHighlights,
  type Highlights,
  type NativeHelper,
} from './stages/highlights.ts';
import {
  DetectionsSchema,
  buildTrackPath,
  facetrackCacheKey,
  type Area,
  type Detections,
  type TrackPath,
  type TrackPathOptions,
} from './stages/facetrack.ts';
import {
  DocTextResultSchema,
  IngestArgsSchema,
  ingest,
  type IngestResult,
} from './stages/ingest.ts';
import { normaliseArea } from './stages/media/activeArea.ts';
import { frameArgs } from './stages/media/derive.ts';
import { FORMAT_WHITELIST } from './stages/media/ffargs.ts';
import { runTool, type RunOptions } from './stages/media/run.ts';
import { sniffFile, type SniffedMedia } from './stages/media/sniff.ts';
import { ShotListSchema, detectShots, type Shot } from './stages/shots.ts';
import {
  TranscribeToolRequestSchema,
  TranscribeToolResultSchema,
  transcribeMedia,
} from './stages/transcribe.ts';

/** Pinned MediaPipe face model (R5): full-range BlazeFace, float16 v1. */
export const FACE_MODEL = {
  name: 'blaze_face_full_range.tflite',
  url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite',
  sha256: '3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b',
  maxBytes: 16 * 1024 * 1024,
  label: 'face model',
} as const;

/** A model file the engine downloads once into `<tools>/models` (URL, SHA-256 and size cap pinned). */
export interface ModelSpec {
  name: string;
  url: string;
  sha256: string;
  maxBytes: number;
  /** Words for messages, e.g. "face model". */
  label: string;
}

export const FacetrackToolRequestSchema = z.strictObject({
  videoPath: z.string().min(1),
  faceModelPath: z.string().min(1),
  ffmpeg: z.string().min(1).optional(),
  ffprobe: z.string().min(1).optional(),
  formatWhitelist: z.string().min(1).optional(),
  sampleFps: z.number().positive().optional(),
  shortSide: z.int().positive().optional(),
  minFaceScore: z.number().min(0).max(1).optional(),
});

export const ActorSchema = z.enum(ACTORS).optional();
/** The agent run that started the job; its history entry carries it, so `undoRun` covers it (D-50). */
export const RunIdSchema = z
  .string()
  .regex(/^run_[A-Za-z0-9_-]{1,64}$/)
  .optional();
const MediaJobArgs = z.strictObject({
  projectId: z.string(),
  mediaId: MediaIdSchema,
  actor: ActorSchema,
  runId: RunIdSchema,
});
export const IngestJobArgsSchema = IngestArgsSchema.extend({
  actor: ActorSchema,
  runId: RunIdSchema,
});
export const TranscribeJobArgsSchema = MediaJobArgs.extend({
  language: z.string().min(1).max(16).optional(),
});
export const ShotsJobArgsSchema = MediaJobArgs;
export const FacetrackJobArgsSchema = MediaJobArgs;
export const HighlightsJobArgsSchema = MediaJobArgs;
export type IngestJobArgs = z.infer<typeof IngestJobArgsSchema>;
export type TranscribeJobArgs = z.infer<typeof TranscribeJobArgsSchema>;
export type MediaJobArgs = z.infer<typeof MediaJobArgs>;

export interface IngestJobResult extends Omit<IngestResult, 'media'> {
  media: {
    input: string;
    source: string;
    mediaId: string;
    kind: MediaItem['kind'];
    reused: boolean;
  }[];
  /** Project version after the job (unchanged when every input was reused). */
  version: number;
}
export interface TranscribeJobResult {
  mediaId: string;
  transcriptPath: string;
  transcriptRev: string;
  language: string;
  words: number;
  cached: boolean;
  dropped: { segments: number; words: number };
  version: number;
}
export interface ShotsJobResult {
  mediaId: string;
  shotsPath: string;
  shots: number;
  cached: boolean;
  /** `proxy` or the original scaled to 360p. */
  input: 'proxy' | 'original';
  version: number;
}
export interface FacetrackJobResult {
  mediaId: string;
  facetrackPath: string;
  samples: number;
  cached: boolean;
  input: 'proxy' | 'original';
  version: number;
}
/**
 * `highlights` (D-75): derived data in `cache/highlights/<mediaId>.json`; the job never changes the
 * project, so it can run beside the other stages without a version race. `available: false` (with
 * the reason): no macOS 27, no native helper, an old helper or no proxy.
 */
export type HighlightsJobResult =
  | {
      mediaId: string;
      available: true;
      /** Project-relative: `cache/highlights/<mediaId>.json`. */
      highlightsPath: string;
      /** Highlight ranges found. */
      highlights: number;
      keyFrameMs: number | null;
      cached: boolean;
    }
  | { mediaId: string; available: false; reason: string };

/** Where the `highlights` job stores a media item's highlights (project-relative). */
export const highlightsPathOf = (mediaId: string): string => `cache/highlights/${mediaId}.json`;

export interface MediaApiDeps {
  tools: Readonly<Record<string, string | undefined>>;
  redactor: Redactor;
  store(projectId: string): Promise<ProjectStore>;
  dirOf(projectId: string): string;
  config(): Promise<Config>;
  /** Test seams for downloads (filtering proxy and the face model fetch). */
  net?: { resolver?: Resolver; dial?: Dial };
  /** `vox-apple-llm` for the `highlights` job (D-75); absent: highlights are not available. */
  appleHelper?: NativeHelper;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function sha256File(path: string): Promise<string | undefined> {
  try {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
    return h.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * The media's active picture area (ingest's `cache/media/<id>.json` `activeArea`, source pixels)
 * normalised to its frame; undefined for the full frame, a missing or damaged entry, or no size.
 */
export async function activeAreaOf(
  projectDir: string,
  media: MediaItem,
): Promise<Area | undefined> {
  if (media.kind !== 'video' || !media.width || !media.height) return undefined;
  try {
    const raw = JSON.parse(
      await readFile(join(projectDir, 'cache', 'media', `${media.id}.json`), 'utf8'),
    ) as { activeArea?: unknown };
    return normaliseArea(raw.activeArea, media.width, media.height);
  } catch {
    return undefined;
  }
}

/** Ingest's content hash (`cache/media/<id>.json`), else the hash of the stored file. */
export async function mediaHashOf(projectDir: string, media: MediaItem): Promise<string> {
  try {
    const raw = JSON.parse(
      await readFile(join(projectDir, 'cache', 'media', `${media.id}.json`), 'utf8'),
    ) as {
      sha256?: unknown;
    };
    if (typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256)) return raw.sha256;
  } catch {
    // fall through
  }
  const h = await sha256File(await resolveProjectPath(projectDir, media.path));
  if (!h) {
    throw new VoxError(
      'NOT_FOUND',
      `The file of media ${media.id} is missing.`,
      'Ingest the media again.',
      {
        details: { mediaId: media.id },
      },
    );
  }
  return h;
}

export function findMedia(p: Project, mediaId: string): MediaItem {
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) {
    throw new VoxError(
      'NOT_FOUND',
      `No media ${mediaId} in project ${p.id}.`,
      'Use a media id from the project.',
      {
        details: { mediaId },
      },
    );
  }
  return m;
}

function needVideo(m: MediaItem, what: string): void {
  if (m.kind !== 'video') {
    throw new VoxError(
      'VALIDATION',
      `${what} needs a video; media ${m.id} is ${m.kind}.`,
      'Pick a video media item.',
      {
        details: { mediaId: m.id },
      },
    );
  }
  if (!m.durationMs) {
    throw new VoxError(
      'MEDIA_UNSUPPORTED',
      `Media ${m.id} has no duration.`,
      'Ingest the media again.',
      {
        details: { mediaId: m.id },
      },
    );
  }
}

/** The video a detection stage reads: the 540p proxy, else the original (CFR copy first) at 360p. */
async function detectionInput(
  dir: string,
  m: MediaItem,
): Promise<{ path: string; format: SniffedMedia['format']; input: 'proxy' | 'original' }> {
  const rel = m.proxyPath ?? m.cfrPath ?? m.path;
  const path = await resolveProjectPath(dir, rel);
  const s = await sniffFile(path);
  if (s.kind !== 'video') {
    throw new VoxError(
      'MEDIA_UNSUPPORTED',
      `Media ${m.id} has no readable video stream.`,
      'Ingest the media again.',
    );
  }
  return { path, format: s.format, input: m.proxyPath ? 'proxy' : 'original' };
}

/** Applies a job's ops as one batch (one history entry), or does nothing when there are none. */
export async function applyJobOps(
  store: ProjectStore,
  ops: OpCall[],
  o: { actor: Actor; jobId: string; baseVersion: number; runId?: string | undefined },
): Promise<number> {
  if (ops.length === 0) return (await store.read()).version;
  const call: OpCall = ops.length === 1 ? ops[0]! : { op: 'batch', args: { ops } };
  const { runId, ...rest } = o;
  const r = await store.apply(call, runId === undefined ? rest : { ...rest, runId });
  // applyOp reports a refused op in its results (JOB_CONFLICT, a failed batch step); the job fails.
  const bad = r.results.find((x) => x.status !== 'succeeded' && x.error)?.error;
  if (bad) {
    throw new VoxError(
      bad.code,
      bad.message,
      bad.hint,
      bad.details ? { details: bad.details } : {},
    );
  }
  return r.version;
}

/** Reads a JSON file and parses it with `schema`, or undefined. */
async function readParsed<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const r = schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

const cancelled = (): VoxError =>
  new VoxError('CANCELLED', 'The download was cancelled.', 'Run it again when ready.');

export interface EnsureModelOptions {
  signal?: AbortSignal;
  net?: { resolver?: Resolver; dial?: Dial };
  /** Test seams. */
  url?: string;
  ca?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The pinned face model in `<tools>/models`. */
export function ensureFaceModel(modelsDir: string, o: EnsureModelOptions = {}): Promise<string> {
  return ensureModel(modelsDir, FACE_MODEL, o);
}

/**
 * A pinned model in `modelsDir` (downloaded once over a checked public connection, SHA-256 verified,
 * written to a temp file and moved into place).
 */
export async function ensureModel(
  modelsDir: string,
  spec: ModelSpec,
  o: EnsureModelOptions = {},
): Promise<string> {
  const path = join(modelsDir, spec.name);
  if ((await sha256File(path)) === spec.sha256) return path;
  await mkdir(modelsDir, { recursive: true, mode: 0o700 });
  const temp = join(
    modelsDir,
    `.vox-part-${process.pid}-${randomBytes(6).toString('hex')}-${spec.name}`,
  );
  try {
    await withRetry(
      async () => {
        if (o.signal?.aborted) throw cancelled();
        const res = await fetchPublic(o.url ?? spec.url, {
          ...(o.net?.resolver ? { resolver: o.net.resolver } : {}),
          ...(o.net?.dial ? { dial: o.net.dial } : {}),
          ...(o.ca ? { ca: o.ca } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
          timeoutMs: 60_000,
        });
        if (res.status !== 200) {
          res.body.resume();
          throw new VoxError(
            'TOOL_FAILED',
            `The ${spec.label} download returned HTTP ${res.status}.`,
            'Check the connection and run it again.',
          );
        }
        const h = createHash('sha256');
        const fh = await open(temp, 'w', 0o644);
        let size = 0;
        try {
          for await (const chunk of res.body) {
            const b = chunk as Buffer;
            size += b.length;
            if (size > spec.maxBytes) {
              res.body.destroy();
              throw new VoxError(
                'NET_TOO_LARGE',
                `The ${spec.label} download is too large.`,
                'Run vox doctor.',
              );
            }
            h.update(b);
            await fh.write(b);
          }
        } finally {
          await fh.close();
        }
        if (h.digest('hex') !== spec.sha256) {
          throw new VoxError(
            'TOOL_FAILED',
            `The downloaded ${spec.label} does not match its pinned SHA-256.`,
            'Run it again; if it keeps failing, run vox doctor.',
          );
        }
      },
      {
        retryable: (e) =>
          e instanceof VoxError && (e.code === 'TOOL_FAILED' || e.code === 'NET_DNS'),
        ...(o.sleep ? { sleep: o.sleep } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      },
    );
    await rename(temp, path);
    return path;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export interface MediaApi {
  /** Facetrack crop path for a media item and sequence aspect (cached under `cache/facetrack/`). */
  facetrackPath(projectId: string, mediaId: string, opts: TrackPathOptions): Promise<TrackPath>;
  /** PNG stills of the source at the given times (cached under `cache/frames/`); absolute paths. */
  mediaFrames(projectId: string, mediaId: string, atMs: readonly number[]): Promise<string[]>;
  /**
   * Apple Vision cards of stills inside the project (`frames`, `mediaFrames`; plan D-73), cached
   * under `cache/cards/` per still content and card version. APPLE_UNAVAILABLE off macOS.
   */
  frameCards(
    projectId: string,
    paths: readonly string[],
    opts?: { signal?: AbortSignal },
  ): Promise<FrameCard[]>;
}

export function registerMediaJobs(runner: JobRunner, deps: MediaApiDeps): MediaApi {
  const tools = deps.tools;
  const redact = (s: string): string => deps.redactor.redact(s);
  const py = (ctx: JobContext): PyBridgeOptions => ({
    pyProject: tools['py'] ?? repoPyProject(),
    ...(tools['uv'] ? { uv: tools['uv'] } : {}),
    ...(tools['pyEnv'] && tools['dir'] ? { toolsDir: tools['dir'] } : {}),
    signal: ctx.signal,
    onProgress: (p, m) => ctx.progress(p, m),
    redactor: deps.redactor,
  });
  const ro = (signal?: AbortSignal): RunOptions => ({
    ...(signal ? { signal } : {}),
    redact,
    tools: {
      ...(tools['ffmpeg'] ? { ffmpeg: tools['ffmpeg'] } : {}),
      ...(tools['ffprobe'] ? { ffprobe: tools['ffprobe'] } : {}),
    },
  });
  /** Opens the project and records the version the job starts from. */
  const begin = async (projectId: string) => {
    const store = await deps.store(projectId);
    const project = await store.read();
    return { store, project, baseVersion: project.version, dir: deps.dirOf(projectId) };
  };

  runner.register<IngestJobArgs, IngestJobResult>('ingest', {
    args: IngestJobArgsSchema,
    async run(args, ctx) {
      const { store, project, baseVersion, dir } = await begin(args.projectId);
      const config = await deps.config();
      const { actor, runId, ...ingestArgs } = args;
      const r = await ingest(
        {
          projectDir: dir,
          existing: project.media,
          tools,
          signal: ctx.signal,
          progress: (p, m) => ctx.progress(p, m),
          redact,
          // S33: the cookies opt-in comes from the user's config only.
          cookiesFromBrowser: config.ingest?.cookiesFromBrowser ?? null,
          docText: (path) =>
            runPyTool('doctext', { path }, DocTextResultSchema, {
              ...py(ctx),
              onProgress: () => undefined,
            }),
          ...(deps.net ? { net: deps.net } : {}),
        },
        ingestArgs,
      );
      const added = new Set<string>();
      const ops: OpCall[] = [];
      for (const m of r.media) {
        if (m.reused || added.has(m.media.id)) continue;
        added.add(m.media.id);
        ops.push({ op: 'addMedia', args: { media: m.media } });
      }
      const version = await applyJobOps(store, ops, {
        actor: actor ?? 'user',
        runId,
        jobId: ctx.jobId,
        baseVersion,
      });
      return {
        media: r.media.map((m) => ({
          input: m.input,
          source: m.source,
          mediaId: m.media.id,
          kind: m.media.kind,
          reused: m.reused,
        })),
        posts: r.posts,
        skipped: r.skipped,
        version,
      };
    },
  });

  runner.register<TranscribeJobArgs, TranscribeJobResult>('transcribe', {
    args: TranscribeJobArgsSchema,
    gpu: true,
    async run(args, ctx) {
      const { store, project, baseVersion, dir } = await begin(args.projectId);
      const media = findMedia(project, args.mediaId);
      const out = await transcribeMedia(
        {
          projectDir: dir,
          tools,
          mediaHash: (m) => mediaHashOf(dir, m),
          runTool: (request) =>
            runPyTool('transcribe', request, TranscribeToolResultSchema, {
              ...py(ctx),
              input: TranscribeToolRequestSchema,
            }),
        },
        media,
        args.language ? { language: args.language } : {},
      );
      const ops: OpCall[] = out.unchanged
        ? []
        : [
            {
              op: 'updateMedia',
              args: {
                mediaId: media.id,
                patch: { transcriptPath: out.transcriptPath, transcriptRev: out.transcriptRev },
              },
            },
          ];
      const version = await applyJobOps(store, ops, {
        actor: args.actor ?? 'user',
        runId: args.runId,
        jobId: ctx.jobId,
        baseVersion,
      });
      return {
        mediaId: media.id,
        transcriptPath: out.transcriptPath,
        transcriptRev: out.transcriptRev,
        language: out.transcript.language,
        words: out.transcript.words.filter((w) => w.kind !== 'pause').length,
        cached: out.cached,
        dropped: out.dropped,
        version,
      };
    },
  });

  runner.register<MediaJobArgs, ShotsJobResult>('shots', {
    args: ShotsJobArgsSchema,
    async run(args, ctx) {
      const { store, project, baseVersion, dir } = await begin(args.projectId);
      const media = findMedia(project, args.mediaId);
      needVideo(media, 'Shot detection');
      const shotsPath = `shots/${media.id}.json`;
      const file = join(dir, shotsPath);
      const src = await detectionInput(dir, media);
      let shots = await readParsed<Shot[]>(file, ShotListSchema);
      const cached = shots !== undefined;
      if (!shots) {
        ctx.progress(0.05, 'detecting cuts');
        shots = await detectShots({
          input: src.path,
          scaleTo360: src.input === 'original',
          formatWhitelist: FORMAT_WHITELIST[src.format],
          durationMs: media.durationMs!,
          signal: ctx.signal,
          ...(tools['ffmpeg'] ? { ffmpeg: tools['ffmpeg'] } : {}),
          redact,
        });
        await mkdir(join(dir, 'shots'), { recursive: true, mode: 0o700 });
        await writeAtomic(file, `${JSON.stringify(shots)}\n`);
      }
      const ops: OpCall[] =
        media.shotsPath === shotsPath
          ? []
          : [{ op: 'updateMedia', args: { mediaId: media.id, patch: { shotsPath } } }];
      const version = await applyJobOps(store, ops, {
        actor: args.actor ?? 'user',
        runId: args.runId,
        jobId: ctx.jobId,
        baseVersion,
      });
      return {
        mediaId: media.id,
        shotsPath,
        shots: shots.length,
        cached,
        input: src.input,
        version,
      };
    },
  });

  runner.register<MediaJobArgs, FacetrackJobResult>('facetrack', {
    args: FacetrackJobArgsSchema,
    async run(args, ctx) {
      const { store, project, baseVersion, dir } = await begin(args.projectId);
      const media = findMedia(project, args.mediaId);
      needVideo(media, 'Face tracking');
      const facetrackPath = `facetracks/${media.id}.json`;
      const file = join(dir, facetrackPath);
      const src = await detectionInput(dir, media);
      let det = await readParsed<Detections>(file, DetectionsSchema);
      const cached = det !== undefined;
      if (!det) {
        const models = tools['models'];
        if (!models) {
          throw new VoxError(
            'TOOL_MISSING',
            'No tools folder for the face model.',
            'Run vox doctor.',
          );
        }
        ctx.progress(0.02, 'face model');
        const faceModelPath = await ensureFaceModel(models, {
          signal: ctx.signal,
          ...(deps.net ? { net: deps.net } : {}),
        });
        det = await runPyTool(
          'facetrack',
          {
            videoPath: src.path,
            faceModelPath,
            formatWhitelist: FORMAT_WHITELIST[src.format],
            ...(tools['ffmpeg'] ? { ffmpeg: tools['ffmpeg'] } : {}),
            ...(tools['ffprobe'] ? { ffprobe: tools['ffprobe'] } : {}),
          },
          DetectionsSchema,
          { ...py(ctx), input: FacetrackToolRequestSchema },
        );
        await mkdir(join(dir, 'facetracks'), { recursive: true, mode: 0o700 });
        await writeAtomic(file, `${JSON.stringify(det)}\n`);
      }
      const ops: OpCall[] =
        media.facetrackPath === facetrackPath
          ? []
          : [{ op: 'updateMedia', args: { mediaId: media.id, patch: { facetrackPath } } }];
      const version = await applyJobOps(store, ops, {
        actor: args.actor ?? 'user',
        runId: args.runId,
        jobId: ctx.jobId,
        baseVersion,
      });
      return {
        mediaId: media.id,
        facetrackPath,
        samples: det.samples.length,
        cached,
        input: src.input,
        version,
      };
    },
  });

  runner.register<MediaJobArgs, HighlightsJobResult>('highlights', {
    args: HighlightsJobArgsSchema,
    // a helper process on the media engine and Neural Engine, about one CPU core: it runs beside
    // the stages that hold the job slots
    outsidePool: true,
    async run(args, ctx) {
      const { project, dir } = await begin(args.projectId);
      const media = findMedia(project, args.mediaId);
      needVideo(media, 'Video highlights');
      const highlightsPath = highlightsPathOf(media.id);
      const file = join(dir, highlightsPath);
      let h = await readParsed<Highlights>(file, HighlightsSchema);
      const cached = h !== undefined;
      if (!h) {
        // the H.264 proxy only: the analyzer fails on VP9 and other sources it cannot decode
        if (!media.proxyPath) {
          return { mediaId: media.id, available: false, reason: 'the media has no preview proxy' };
        }
        ctx.progress(0.05, 'finding highlights');
        const r = await runHighlights(
          deps.appleHelper,
          await resolveProjectPath(dir, media.proxyPath),
          { signal: ctx.signal, timeoutMs: highlightsTimeoutMs(media.durationMs!), redact },
        );
        if (!r.available) return { mediaId: media.id, available: false, reason: r.reason };
        h = r.highlights;
        await mkdir(join(dir, 'cache', 'highlights'), { recursive: true, mode: 0o700 });
        await writeAtomic(file, `${JSON.stringify(h)}\n`);
      }
      return {
        mediaId: media.id,
        available: true,
        highlightsPath,
        highlights: h.highlights.length,
        keyFrameMs: h.keyFrameMs,
        cached,
      };
    },
  });

  return {
    async facetrackPath(projectId, mediaId, opts) {
      const dir = deps.dirOf(projectId);
      const media = findMedia(await (await deps.store(projectId)).read(), mediaId);
      if (!media.facetrackPath || !media.shotsPath) {
        throw new VoxError(
          'NOT_FOUND',
          `Media ${mediaId} needs shots and facetrack first.`,
          `Run vox shots and vox facetrack on ${mediaId}.`,
          { details: { mediaId } },
        );
      }
      const detText = await readFile(await resolveProjectPath(dir, media.facetrackPath), 'utf8');
      const shotText = await readFile(await resolveProjectPath(dir, media.shotsPath), 'utf8');
      const area = await activeAreaOf(dir, media);
      const key = facetrackCacheKey({
        mediaHash: await mediaHashOf(dir, media),
        aspect: opts.aspect,
        mode: opts.mode,
        ...(opts.stability ? { stability: opts.stability } : {}),
        ...(opts.trackSpeed ? { trackSpeed: opts.trackSpeed } : {}),
        ...(opts.faceIndex !== undefined ? { faceIndex: opts.faceIndex } : {}),
        inputsHash: sha256Hex(`${detText}\n${shotText}`),
        ...(area ? { area } : {}),
      });
      const cacheFile = join(dir, 'cache', 'facetrack', `${key}.json`);
      try {
        const hit = JSON.parse(await readFile(cacheFile, 'utf8')) as Partial<TrackPath>;
        // A damaged cache file is rebuilt, not returned.
        if (Array.isArray(hit.keyframes) && Array.isArray(hit.shots)) return hit as TrackPath;
      } catch {
        // build it
      }
      const path = buildTrackPath(
        DetectionsSchema.parse(JSON.parse(detText)),
        ShotListSchema.parse(JSON.parse(shotText)),
        opts,
        area,
      );
      await mkdir(join(dir, 'cache', 'facetrack'), { recursive: true, mode: 0o700 });
      await writeAtomic(cacheFile, JSON.stringify(path));
      return path;
    },

    async mediaFrames(projectId, mediaId, atMs) {
      const dir = deps.dirOf(projectId);
      const media = findMedia(await (await deps.store(projectId)).read(), mediaId);
      if (media.kind === 'image') return atMs.map(() => join(dir, media.path));
      needVideo(media, 'Media frames');
      if (atMs.length === 0 || atMs.length > 100) {
        throw new VoxError(
          'VALIDATION',
          'Pass 1 to 100 times.',
          'Use --at-ms with up to 100 values.',
        );
      }
      const srcPath = await resolveProjectPath(dir, media.cfrPath ?? media.path);
      const s = await sniffFile(srcPath);
      if (s.kind !== 'video') {
        throw new VoxError(
          'MEDIA_UNSUPPORTED',
          `Media ${mediaId} has no readable video stream.`,
          'Ingest the media again.',
        );
      }
      const framesDir = join(dir, 'cache', 'frames');
      await mkdir(framesDir, { recursive: true, mode: 0o700 });
      const out: string[] = [];
      for (const t of atMs) {
        if (!Number.isInteger(t) || t < 0 || t > media.durationMs!) {
          throw new VoxError(
            'MEDIA_BOUNDS',
            `${t} ms is outside media ${mediaId} (0–${media.durationMs} ms).`,
            'Pick a time inside the media.',
            {
              details: { mediaId, atMs: t },
            },
          );
        }
        const file = join(framesDir, `${mediaId}-${t}.png`);
        const ok = await stat(file).then(
          (st) => st.size > 0,
          () => false,
        );
        if (!ok) {
          const temp = join(
            framesDir,
            `.vox-part-${process.pid}-${randomBytes(6).toString('hex')}.png`,
          );
          try {
            // The last frame sits just before durationMs; seek a little earlier at the very end.
            const at = Math.max(0, Math.min(t, media.durationMs! - 50));
            await runTool('ffmpeg', frameArgs(srcPath, s.format, at, temp), ro());
            await rename(temp, file);
          } finally {
            await unlink(temp).catch(() => undefined);
          }
        }
        out.push(file);
      }
      return out;
    },

    frameCards(projectId, paths, opts = {}) {
      return frameCards(
        {
          projectDir: deps.dirOf(projectId),
          py: {
            pyProject: tools['py'] ?? repoPyProject(),
            ...(tools['uv'] ? { uv: tools['uv'] } : {}),
            ...(tools['pyEnv'] && tools['dir'] ? { toolsDir: tools['dir'] } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
            redactor: deps.redactor,
          },
        },
        paths,
      );
    },
  };
}
