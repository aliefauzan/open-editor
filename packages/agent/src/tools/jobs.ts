// Job tools (agent spec "Job tools") and check_audio (plan D-14). A job runs as actor `agent`;
// the loop waits for it. A job that writes to the project and meets a user edit fails with
// JOB_CONFLICT; the tool runs it once more on the current project (agent spec "Error handling").
// There is no render or export tool and no argument that takes an output path (S32, D-13).
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import { presentImages, readStill } from './read.ts';
import { unapprovedSources } from './sources.ts';
import type { AgentEngine, AgentTool, ToolContext, ToolOutput } from './types.ts';

const id = z.string().min(1);

/** Starts a job and waits; a failed job throws its (already redacted) error as a VoxError. */
export async function runEngineJob(
  engine: Pick<AgentEngine, 'jobs'>,
  kind: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const jobId = engine.jobs.start(kind, args);
  const onAbort = () => engine.jobs.cancel(jobId);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const info = await engine.jobs.wait(jobId);
    if (info.status === 'done') return info.result;
    const e = info.error;
    throw new VoxError(
      e?.code ?? 'JOB_FAILED',
      e?.message ?? `job ${kind} ${info.status}`,
      e?.hint ?? 'Try again.',
      { details: { jobId, kind, ...(e?.details ?? {}) } },
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Runs a job on the run's project; a JOB_CONFLICT runs it once more on the current project.
 * `signal` (default: the run's) cancels it.
 */
export async function job(
  ctx: Pick<ToolContext, 'projectId' | 'runJob' | 'engine' | 'signal'>,
  kind: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined = ctx.signal,
): Promise<unknown> {
  const full = { projectId: ctx.projectId, ...args };
  const run = () =>
    ctx.runJob ? ctx.runJob(kind, full, signal) : runEngineJob(ctx.engine, kind, full, signal);
  try {
    return await run();
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'JOB_CONFLICT') throw e;
    return run(); // re-read once: the job starts again from the current project
  }
}

async function versionNow(ctx: ToolContext): Promise<number> {
  const p = await ctx.engine.getProject(ctx.projectId);
  return p.version;
}

/** Runs a job that may write to the project; reports the version it created, if any. */
async function writingJob(
  ctx: ToolContext,
  kind: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  const before = await versionNow(ctx);
  const result = await job(ctx, kind, { ...args, actor: 'agent', runId: ctx.runId });
  const after = await versionNow(ctx);
  if (after > ctx.seenVersion && before === ctx.seenVersion) ctx.seenVersion = after;
  return {
    result: ctx.aliases.toModel({ version: after, result }),
    ...(after > before && { versions: [after] }),
  };
}

const tool = <S extends z.ZodType>(
  name: string,
  kind: 'job' | 'read',
  description: string,
  input: S,
  run: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolOutput>,
): AgentTool => ({
  name,
  kind,
  description,
  input,
  run: (ctx, args) => run(ctx, args as z.infer<S>),
});

interface QaCheck {
  id: string;
  status?: string;
  pass?: boolean;
  [k: string]: unknown;
}

export function jobTools(engine: Pick<AgentEngine, 'imageProviders'>): AgentTool[] {
  const tools: AgentTool[] = [
    tool(
      'ingest',
      'job',
      'Add a video, audio or image to the project from a link or a file the user named in this conversation. Any other source pauses the run for the user’s approval.',
      z.strictObject({ source: z.string().min(1).max(2000) }),
      async (ctx, a) => {
        const pending = unapprovedSources([a.source], ctx.userSources, ctx.approvedSources);
        if (pending.length > 0) {
          return {
            result: { status: 'paused', reason: 'source not named by the user' },
            pause: {
              reason: 'approval',
              kind: 'source',
              detail: 'ingest of a source the user did not name',
              sources: pending,
            },
          };
        }
        return writingJob(ctx, 'ingest', { inputs: [a.source] });
      },
    ),
    tool(
      'shots',
      'job',
      'Detect shot cuts of a video (writes shots/<mediaId>.json).',
      z.strictObject({ mediaId: id }),
      (ctx, a) => writingJob(ctx, 'shots', { mediaId: a.mediaId }),
    ),
    tool(
      'transcribe',
      'job',
      'Transcribe media items (word times, kinds).',
      z.strictObject({ mediaIds: z.array(id).min(1).max(20) }),
      async (ctx, a) => {
        const outs: unknown[] = [];
        const versions: number[] = [];
        for (const mediaId of a.mediaIds) {
          const o = await writingJob(ctx, 'transcribe', { mediaId });
          outs.push(o.result);
          versions.push(...(o.versions ?? []));
        }
        return { result: { results: outs }, ...(versions.length > 0 && { versions }) };
      },
    ),
    tool(
      'facetrack',
      'job',
      'Track faces of a video for auto framing.',
      z.strictObject({ mediaId: id }),
      (ctx, a) => writingJob(ctx, 'facetrack', { mediaId: a.mediaId }),
    ),
    tool(
      'search_images',
      'job',
      'Search the open archives (Wikimedia Commons, Openverse) for images; returns candidate ids with title, author and licence.',
      z.strictObject({
        query: z.string().trim().min(1).max(200),
        sources: z
          .array(z.enum(['commons', 'openverse']))
          .min(1)
          .optional(),
      }),
      async (ctx, a) => ({
        untrusted: 'archive',
        result: ctx.aliases.toModel(
          await job(ctx, 'assets.search', {
            query: a.query,
            ...(a.sources && { sources: a.sources }),
          }),
        ),
      }),
    ),
    tool(
      'fetch_image',
      'job',
      'Download an archive candidate into the project as a media item.',
      z.strictObject({ candidateId: z.string().min(1).max(80) }),
      (ctx, a) => writingJob(ctx, 'assets.fetch', { candidateId: a.candidateId }),
    ),
    tool(
      'cutout',
      'job',
      'Cut the subject of an image out (transparent PNG media item).',
      z.strictObject({ mediaId: id }),
      (ctx, a) => writingJob(ctx, 'assets.cutout', { mediaId: a.mediaId }),
    ),
    tool(
      'check_audio',
      'read',
      'Run the audio QA of a sequence: the check table with numbers, the cue list with drops, five listen timecodes for a human, and the qa.png picture. A FAIL comes back as data; fix it through ops. Never claim the sound is good: no model can hear it.',
      z.strictObject({ sequenceId: id }),
      async (ctx, a) => {
        const qa = (await job(ctx, 'audioQa', { sequenceId: a.sequenceId })) as {
          pass: boolean;
          png: string;
          checks?: QaCheck[];
          listen?: { atMs: number; timecode?: string; kind?: string; listenFor?: string }[];
          cues?: unknown[];
          targetLufs?: number;
          durationMs?: number;
        };
        const build = await ctx.engine.compile(ctx.projectId, a.sequenceId, { mode: 'render' });
        const png = await readStill(ctx, qa.png, 'qa.png');
        const shown = await presentImages(
          ctx,
          [png],
          'This is an audio QA picture: numbered cue markers on top, then waveform rows (sfx, speech, mix) with green onset ticks. For each hero cue marker, describe what the waveforms show around it. Read numbers only; do not judge how it sounds.',
        );
        return {
          result: ctx.aliases.toModel({
            pass: qa.pass,
            targetLufs: qa.targetLufs,
            durationMs: qa.durationMs,
            checks: qa.checks ?? [],
            cues: qa.cues ?? [],
            dropped: build.cues.dropped.map((d) => ({
              atMs: d.cue.atMs,
              sfx: d.cue.sfx,
              itemId: d.cue.itemId,
              reason: d.reason,
            })),
            listen: (qa.listen ?? []).map((l) => ({
              atMs: l.atMs,
              timecode: l.timecode,
              kind: l.kind,
              listenFor: l.listenFor,
            })),
            ...(shown?.description !== undefined && { picture: shown.description }),
            ...(shown === null && {
              picture: 'no vision model: qa.png not described; use the numbers above',
            }),
          }),
          ...(shown?.images && { images: shown.images }),
        };
      },
    ),
  ];
  if (engine.imageProviders.list().length > 0) {
    tools.push(
      tool(
        'generate_image',
        'job',
        'Generate an image (only when archive search found nothing).',
        z.strictObject({ prompt: z.string().trim().min(1).max(2000), styleId: id.optional() }),
        (ctx, a) =>
          writingJob(ctx, 'assets.generate', {
            prompt: a.prompt,
            ...(a.styleId && { styleId: a.styleId }),
          }),
      ),
    );
  }
  return tools;
}
