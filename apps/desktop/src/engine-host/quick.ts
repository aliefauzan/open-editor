// "Make clips" on the quick-clips start screen (app spec "Quick clips (start screen)"; plan D-11, 10b
// step 1): after the import job, one app job `makeClips` runs shots → transcribe and, beside them,
// facetrack, highlights and sound tags, then `quickClips` on the engine, and reports one progress
// (0..1, each stage weighted by its cost; decision "Quick clips speed"). Highlights (macOS 27 video
// highlights, D-75) and sound tags (SoundAnalysis reactions, D-83) take no engine job slot and are
// optional: "not available", a failure, or still running HIGHLIGHTS_GRACE_MS after the other
// stages (then cancelled) leave the clips as without them. Two stages on one media item can race for the project
// version: the one that loses ends JOB_CONFLICT and is run again (its tool output is cached, so only
// the media update is redone). It runs in the
// engine host beside the engine's job runner, not inside it: a job that waits on other jobs in the
// same runner could take every slot. Its events and `jobs.get` / `jobs.cancel` look like engine jobs.
//
// Test builds (`VOX_E2E=1`, unpackaged) seed the checked-in transcript, shots and facetrack of the
// seed media by media hash (plan D-16; R7 `SEEDS.json`), so the quick path runs with no mlx-whisper
// and no Python facetrack. Release builds never seed.
//
// With a `fast` model in Settings the pick uses the agent's LLM scorer (phase 13; D-50): the job asks
// the engine for the `llm` scorer and runs inside `withLlmScorer`. Without a fast model, or when the
// scorer fails or its budget is spent, the engine's heuristic picks (the engine falls back itself).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withLlmScorer } from '@vox/agent';
import type { Engine, QuickClipScorer } from '@vox/engine';
import { projectDirFor, resolveProjectPath } from '@vox/engine/paths';
import type { ErrorData, EventName } from '../shared/api.ts';
import { toErrorData } from './rpc.ts';

export const APP_JOB_KINDS = ['makeClips'] as const;

export interface MakeClipsArgs {
  projectId: string;
  mediaId: string;
  count?: number;
  minMs?: number;
  maxMs?: number;
}

interface AppJob {
  id: string;
  kind: string;
  projectId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  message?: string;
  result?: unknown;
  error?: ErrorData;
  abort: AbortController;
}

/** The checked-in seeds: `assets/media/SEEDS.json` (file → sha256) and `<folder>/<stem>.json`. */
export interface SeedSource {
  /** `packages/engine/test/fixtures` */
  dir: string;
}

const STAGES = ['shots', 'transcribe', 'facetrack'] as const;
/** Stages that only add a signal to the pick and never block it (D-75, D-83). */
const OPTIONAL = ['highlights', 'sounds'] as const;
type Stage = (typeof STAGES)[number] | (typeof OPTIONAL)[number] | 'quickClips';

/**
 * Share of the progress bar per stage, from a 15-min 1080p talk: facetrack (~2 min on 4 threads)
 * and transcribe (~1 min) dominate; highlights (macOS 27 only, D-75; ~0.09 × the video's length)
 * and sound tags (D-83; about 1 s per 4 min) run beside them; shots and the pick take seconds.
 */
export const STAGE_WEIGHT: Readonly<Record<Stage, number>> = {
  shots: 0.05,
  transcribe: 0.3,
  facetrack: 0.48,
  highlights: 0.1,
  sounds: 0.02,
  quickClips: 0.05,
};
/** Re-runs of a stage that lost the version race to its sibling (JOB_CONFLICT). */
const CONFLICT_RETRIES = 3;
const ORDER: readonly Stage[] = [
  'shots',
  'transcribe',
  'facetrack',
  'highlights',
  'sounds',
  'quickClips',
];
/**
 * How long the pick waits for highlights (and sound tags, D-83) once shots, transcribe and facetrack
 * are done (D-75). On a 667 s talk on an M5 highlights took 59 s against 46 s for shots →
 * transcribe.
 */
export const HIGHLIGHTS_GRACE_MS = 30_000;
const FIELD = { shots: 'shotsPath', transcribe: 'transcriptPath', facetrack: 'facetrackPath' };
const FOLDER = { shots: 'shots', transcribe: 'transcripts', facetrack: 'facetracks' };

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const cancelled = (): ErrorData => ({
  code: 'CANCELLED',
  message: 'Make clips was cancelled',
  hint: 'Start it again when you are ready',
});

export class AppJobs {
  private readonly jobs = new Map<string, AppJob>();
  private n = 0;

  private readonly engine: Engine;
  private readonly emit: (name: EventName, payload: unknown) => void;
  private readonly seeds: SeedSource | undefined;
  private readonly llmScorer: (() => Promise<QuickClipScorer | undefined>) | undefined;
  private readonly highlightsGraceMs: number;

  constructor(
    engine: Engine,
    emit: (name: EventName, payload: unknown) => void,
    seeds?: SeedSource,
    llmScorer?: () => Promise<QuickClipScorer | undefined>,
    opts: { highlightsGraceMs?: number } = {},
  ) {
    this.engine = engine;
    this.emit = emit;
    this.seeds = seeds;
    this.llmScorer = llmScorer;
    this.highlightsGraceMs = opts.highlightsGraceMs ?? HIGHLIGHTS_GRACE_MS;
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  get(id: string): Omit<AppJob, 'abort'> {
    const info: Partial<AppJob> = { ...this.jobs.get(id)! };
    delete info.abort;
    return info as Omit<AppJob, 'abort'>;
  }

  cancel(id: string): void {
    this.jobs.get(id)?.abort.abort();
  }

  start(kind: string, args: Record<string, unknown>): string {
    const a = args as unknown as MakeClipsArgs;
    if (typeof a.projectId !== 'string' || typeof a.mediaId !== 'string') {
      throw { code: 'VALIDATION', message: 'makeClips needs projectId and mediaId', hint: '' };
    }
    const id = `job_app${(++this.n).toString(36)}${Date.now().toString(36)}`;
    const job: AppJob = {
      id,
      kind,
      projectId: a.projectId,
      status: 'running',
      progress: 0,
      abort: new AbortController(),
    };
    this.jobs.set(id, job);
    const ref = { jobId: id, kind, projectId: a.projectId };
    this.emit('job.started', ref);
    const progress = (p: number, message: string) => {
      job.progress = Math.max(job.progress, Math.min(1, p));
      job.message = message;
      this.emit('job.progress', { ...ref, progress: job.progress, message });
    };
    void this.makeClips(a, job, progress).then(
      (result) => {
        job.status = 'done';
        job.progress = 1;
        job.result = result;
        this.emit('job.done', { ...ref, result });
      },
      (e: unknown) => {
        if (job.abort.signal.aborted) {
          job.status = 'cancelled';
          job.error = cancelled();
          this.emit('job.cancelled', ref);
          return;
        }
        job.status = 'failed';
        job.error = toErrorData(e);
        this.emit('job.failed', { ...ref, error: job.error });
      },
    );
    return id;
  }

  /** Runs one engine job; its progress (0..1) goes to `onProgress`. Abort cancels the job. */
  private async child(
    kind: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (p: number) => void,
  ): Promise<unknown> {
    if (signal.aborted) throw cancelled();
    const id = this.engine.jobs.start(kind, args);
    const off = this.engine.jobs.on('job.progress', (e) => {
      if (e.jobId === id) onProgress(e.progress);
    });
    const onAbort = () => this.engine.jobs.cancel(id);
    signal.addEventListener('abort', onAbort);
    try {
      const info = await this.engine.jobs.wait(id);
      if (info.status === 'done') return info.result;
      if (info.status === 'cancelled') throw cancelled();
      throw info.error ?? { code: 'JOB_FAILED', message: `${kind} failed`, hint: '' };
    } finally {
      off();
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** `child`, run again when it loses the project-version race to a sibling stage. */
  private async stage(
    kind: Stage,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (p: number) => void,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.child(kind, args, signal, onProgress);
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (code !== 'JOB_CONFLICT' || attempt >= CONFLICT_RETRIES || signal.aborted) throw e;
      }
    }
  }

  private async makeClips(
    a: MakeClipsArgs,
    job: AppJob,
    progress: (p: number, m: string) => void,
  ): Promise<unknown> {
    const base = { projectId: a.projectId, mediaId: a.mediaId, actor: 'user' };
    const done = new Map<Stage, number>();
    const running = new Set<Stage>();
    const report = (): void => {
      let p = 0;
      for (const k of ORDER) p += STAGE_WEIGHT[k] * (done.get(k) ?? 0);
      progress(p, runningLabel(ORDER.filter((k) => running.has(k))));
    };
    const tracked = async (kind: Stage, args: Record<string, unknown>, signal: AbortSignal) => {
      running.add(kind);
      report();
      try {
        return await this.stage(kind, args, signal, (p) => {
          done.set(kind, Math.max(done.get(kind) ?? 0, Math.min(1, p)));
          report();
        });
      } finally {
        running.delete(kind);
        done.set(kind, 1);
      }
    };

    const seeded = this.seeds ? await this.seed(a, this.seeds) : false;
    if (!seeded) {
      // One failure stops the other branch; the first error is the one reported.
      const inner = new AbortController();
      const stop = () => inner.abort();
      job.abort.signal.addEventListener('abort', stop);
      let first: { error: unknown } | undefined;
      const branch = async (kinds: readonly Stage[]): Promise<void> => {
        try {
          for (const k of kinds) await tracked(k, base, inner.signal);
        } catch (e) {
          first ??= { error: e };
          inner.abort();
        }
      };
      // highlights and sound tags never block a clip: "not available", a failure, a cancel, or
      // still running HIGHLIGHTS_GRACE_MS after the other stages all leave the pick as it is
      // without them
      const hlAbort = new AbortController();
      const stopHl = () => hlAbort.abort();
      inner.signal.addEventListener('abort', stopHl);
      const hl = Promise.all(
        OPTIONAL.map((k) =>
          tracked(k, base, hlAbort.signal).then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
      try {
        await Promise.all([branch(['shots', 'transcribe']), branch(['facetrack'])]);
        if (!first) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            hl,
            new Promise<void>((r) => (timer = setTimeout(r, this.highlightsGraceMs))),
          ]);
          clearTimeout(timer);
        }
      } finally {
        hlAbort.abort();
        await hl;
        inner.signal.removeEventListener('abort', stopHl);
        job.abort.signal.removeEventListener('abort', stop);
      }
      if (first) throw first.error;
    } else {
      // test builds: seeded media skip highlights and sound tags too, so the pick stays the
      // seeded one
      for (const k of [...STAGES, ...OPTIONAL]) done.set(k, 1);
    }
    const scorer = await this.llmScorer?.().catch(() => undefined);
    const pick = () =>
      tracked(
        'quickClips',
        {
          ...base,
          ...(a.count === undefined ? {} : { count: a.count }),
          ...(a.minMs === undefined ? {} : { minMs: a.minMs }),
          ...(a.maxMs === undefined ? {} : { maxMs: a.maxMs }),
          ...(scorer ? { scorer: 'llm' } : {}),
        },
        job.abort.signal,
      );
    return scorer ? withLlmScorer(this.engine, scorer, pick, { signal: job.abort.signal }) : pick();
  }

  /**
   * Test builds: the agent's analysis jobs on a seed media take the seed for that one stage (as the
   * run's actor and runId). False when this is not a test build or the media is not a seed.
   */
  async seedStage(
    kind: string,
    a: { projectId: string; mediaId: string },
    by: { actor: 'user' | 'agent'; runId?: string },
  ): Promise<boolean> {
    if (!this.seeds || !(STAGES as readonly string[]).includes(kind)) return false;
    return this.seed(a, this.seeds, [kind as (typeof STAGES)[number]], by);
  }

  /** Test builds: copy the seeds of a seed media (matched by SHA-256) into the project. */
  private async seed(
    a: { projectId: string; mediaId: string },
    seeds: SeedSource,
    kinds: readonly (typeof STAGES)[number][] = STAGES,
    by: { actor: 'user' | 'agent'; runId?: string } = { actor: 'user' },
  ): Promise<boolean> {
    let table: Record<string, { sha256: string }>;
    try {
      table = JSON.parse(
        await readFile(join(seeds.dir, 'assets', 'media', 'SEEDS.json'), 'utf8'),
      ) as typeof table;
    } catch {
      return false;
    }
    const project = await this.engine.getProject(a.projectId);
    const media = project.media.find((m) => m.id === a.mediaId);
    if (!media) return false;
    const dir = projectDirFor(this.engine.projectsDir, a.projectId);
    const hash = await sha256(await resolveProjectPath(dir, media.path));
    const name = Object.keys(table).find((k) => table[k]?.sha256 === hash);
    if (!name) return false;
    const stem = basename(name).replace(/\.[^.]+$/, '');
    const patch: Record<string, string> = {};
    for (const kind of kinds) {
      const rel = `${FOLDER[kind]}/${a.mediaId}.json`;
      await mkdir(join(dir, FOLDER[kind]), { recursive: true });
      const src = join(seeds.dir, FOLDER[kind], `${stem}.json`);
      await copyFile(src, join(dir, rel));
      patch[FIELD[kind]] = rel;
      if (kind === 'transcribe') {
        patch['transcriptRev'] = createHash('sha256')
          .update(await readFile(src))
          .digest('hex')
          .slice(0, 16);
      }
    }
    const r = await this.engine.applyOp(
      a.projectId,
      { op: 'updateMedia', args: { mediaId: a.mediaId, patch } } as never,
      by,
    );
    const bad = r.results.find((x) => x.status !== 'succeeded');
    if (bad) throw bad.error;
    return true;
  }
}

const LABEL: Readonly<Record<Stage, string>> = {
  shots: 'Finding shots',
  transcribe: 'Transcribing',
  facetrack: 'Tracking faces',
  highlights: 'Finding highlights',
  sounds: 'Tagging sounds',
  quickClips: 'Picking clips',
};

/**
 * "Transcribing and tracking faces" for the stages running now (in chain order). Highlights and
 * sound tags run beside the others and are named only when nothing else runs, one at a time
 * (highlights first).
 */
function runningLabel(running: readonly Stage[]): string {
  const optional = (k: Stage) => (OPTIONAL as readonly Stage[]).includes(k);
  const required = running.filter((k) => !optional(k));
  const kinds = required.length > 0 ? required : running.slice(0, 1);
  if (kinds.length === 0) return 'Making clips';
  return kinds
    .map((k, i) => (i === 0 ? LABEL[k] : LABEL[k].charAt(0).toLowerCase() + LABEL[k].slice(1)))
    .join(' and ');
}
