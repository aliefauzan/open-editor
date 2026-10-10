// Job `quickClips` (engine spec "Quick clips", plan D-11, D-15): reads the media's transcript, shots,
// facetrack detections and peaks, picks the clips (stages/quickClips.ts) and writes one sequence per
// pick in one `batch` carrying the job's id, so "Undo quick clips" is one history entry.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { VoxError } from './errors.ts';
import type { ProjectStore } from './history/store.ts';
import type { JobRunner } from './jobs.ts';
import { ActorSchema, applyJobOps, findMedia } from './media-api.ts';
import { DEFAULT_FPS, isFpsInSet, type Fps } from './model/fps.ts';
import { newId } from './model/ids.ts';
import { TranscriptSchema, type MediaItem, type Transcript } from './model/schema.ts';
import type { OpCall } from './ops/index.ts';
import { resolveProjectPath } from './paths.ts';
import { DetectionsSchema, type Detections } from './stages/facetrack.ts';
import { fpsValue, nearestFixedFps } from './stages/media/analyze.ts';
import {
  HEURISTIC,
  createQuickClipScorers,
  heuristicScores,
  pickClips,
  quickCandidates,
  type Candidate,
  type Peaks,
} from './stages/quickClips.ts';
import { ShotListSchema, type Shot } from './stages/shots.ts';

export const QuickClipsArgsSchema = z
  .strictObject({
    projectId: z.string(),
    mediaId: z.string(),
    count: z.int().min(1).max(20).default(3),
    minMs: z.int().min(1000).max(600_000).default(30_000),
    maxMs: z.int().min(1000).max(600_000).default(60_000),
    /** A registered scorer id, or `heuristic`; omitted → the most recently registered, else the heuristic. */
    scorer: z.string().min(1).max(64).optional(),
    /** Passed to a registered scorer (e.g. "moments about pricing"); the heuristic ignores it. */
    prompt: z.string().max(2000).optional(),
    actor: ActorSchema,
  })
  .refine((a) => a.minMs <= a.maxMs, { message: 'minMs must not be more than maxMs' });
export type QuickClipsArgs = z.input<typeof QuickClipsArgsSchema>;

export interface QuickClip {
  sequenceId: string;
  name: string;
  startMs: number;
  endMs: number;
  text: string;
  score: number;
}

export interface QuickClipsResult {
  mediaId: string;
  /** The scorer whose scores chose the clips (`heuristic` after a fallback). */
  scorer: string;
  /** Set when a registered scorer failed and the heuristic was used instead. */
  scorerError?: { scorer: string; message: string };
  requested: number;
  candidates: number;
  clips: QuickClip[];
  sequenceIds: string[];
  /** Set when fewer than `count` clips fit. */
  note?: string;
  version: number;
}

const PeaksSchema = z.looseObject({
  peaksPerSecond: z.number().positive(),
  peaks: z.array(z.number()),
});

export interface QuickApiDeps {
  store(projectId: string): Promise<ProjectStore>;
  dirOf(projectId: string): string;
}

async function readJson<T>(dir: string, rel: string | undefined, schema: z.ZodType<T>): Promise<T | undefined> {
  if (!rel) return undefined;
  try {
    const r = schema.safeParse(JSON.parse(await readFile(await resolveProjectPath(dir, rel), 'utf8')));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** 1080×1920 at the source's rate when it is in the fixed set, else the nearest one in the set. */
export function quickClipFps(media: MediaItem): Fps {
  if (!media.fps) return { ...DEFAULT_FPS };
  return isFpsInSet(media.fps) ? { ...media.fps } : nearestFixedFps(fpsValue(media.fps));
}

export function registerQuickClipJobs(runner: JobRunner, deps: QuickApiDeps) {
  const scorers = createQuickClipScorers();

  runner.register<z.output<typeof QuickClipsArgsSchema>, QuickClipsResult>('quickClips', {
    args: QuickClipsArgsSchema,
    async run(args, ctx) {
      const store = await deps.store(args.projectId);
      const project = await store.read();
      const dir = deps.dirOf(args.projectId);
      const media = findMedia(project, args.mediaId);
      if (media.kind !== 'video') {
        throw new VoxError(
          'MEDIA_UNSUPPORTED',
          `Quick clips need a video, and ${media.id} is ${media.kind === 'image' ? 'an image' : `${media.kind} media`}`,
          'Pick a video from the media list.',
        );
      }
      const transcript: Transcript | undefined = await readJson(dir, media.transcriptPath, TranscriptSchema);
      if (!transcript) {
        throw new VoxError(
          'VALIDATION',
          `Media ${media.id} has no transcript`,
          `Transcribe it first: vox transcribe ${media.id}`,
        );
      }
      const shots: Shot[] | undefined = await readJson(dir, media.shotsPath, ShotListSchema);
      const detections: Detections | undefined = await readJson(dir, media.facetrackPath, DetectionsSchema);
      const peaks: Peaks | undefined = await readJson(dir, media.peaksPath, PeaksSchema);
      const sourceFps = media.fps ?? DEFAULT_FPS;

      ctx.progress(0.1, 'finding sentence ranges');
      const cands = quickCandidates(transcript, {
        minMs: args.minMs,
        maxMs: args.maxMs,
        ...(shots ? { shots } : {}),
        sourceFps,
      });
      const chosen = scorers.resolve(args.scorer);
      let scorer = HEURISTIC;
      let scorerError: QuickClipsResult['scorerError'];
      let scores: readonly number[] | undefined;
      if (chosen && cands.length > 0) {
        ctx.progress(0.3, `scoring with ${chosen.id}`);
        try {
          const got = await chosen.fn(
            {
              mediaId: media.id,
              ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
              candidates: cands.map((c, index) => ({ index, startMs: c.startMs, endMs: c.endMs, text: c.text })),
            },
            { signal: ctx.signal },
          );
          if (!Array.isArray(got) || got.length !== cands.length || !got.every((x) => Number.isFinite(x))) {
            throw new Error(`returned ${Array.isArray(got) ? got.length : 'no'} scores for ${cands.length} candidates`);
          }
          scores = got;
          scorer = chosen.id;
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          scorerError = { scorer: chosen.id, message: e instanceof Error ? e.message : String(e) };
        }
      }
      scores ??= heuristicScores(cands, transcript, { peaks, detections }).scores;
      const picks = pickClips(cands, scores, args.count);

      const fps = quickClipFps(media);
      const ops: OpCall[] = [];
      const clips: QuickClip[] = picks.map((i, n) => {
        const c: Candidate = cands[i]!;
        const sequenceId = newId('seq_');
        const name = `Clip ${n + 1}`;
        ops.push(
          {
            op: 'addSequence',
            args: { name, id: sequenceId, canvas: { width: 1080, height: 1920, fps }, styleId: 'base' },
          },
          {
            op: 'updateSequence',
            args: { sequenceId, sourceRange: { mediaId: media.id, inMs: c.startMs, outMs: c.endMs } },
          },
          {
            op: 'placeClip',
            args: {
              sequenceId,
              trackId: 'V1',
              mediaId: media.id,
              startMs: 0,
              inMs: c.startMs,
              durationMs: c.endMs - c.startMs,
              withAudio: media.hasAudio,
              frame: { mode: 'auto' },
            },
          },
          {
            op: 'setCaptions',
            args: { sequenceId, enabled: true, sourceTrackIds: ['A1'], preset: 'base/plain', maxWords: 3 },
          },
        );
        return { sequenceId, name, startMs: c.startMs, endMs: c.endMs, text: c.text, score: scores[i]! };
      });
      const version = await applyJobOps(store, ops, {
        actor: args.actor ?? 'user',
        jobId: ctx.jobId,
        baseVersion: project.version,
      });
      return {
        mediaId: media.id,
        scorer,
        ...(scorerError ? { scorerError } : {}),
        requested: args.count,
        candidates: cands.length,
        clips,
        sequenceIds: clips.map((c) => c.sequenceId),
        ...(clips.length < args.count
          ? {
              note: `Found ${clips.length} of ${args.count} clips: only ${clips.length} non-overlapping range${clips.length === 1 ? '' : 's'} of whole sentences fit ${args.minMs}–${args.maxMs} ms.`,
            }
          : {}),
        version,
      };
    },
  });

  return { registerScorer: scorers.registerScorer, scorers: scorers.scorers };
}
