// Job runner (engine spec "Library API" → jobs, events; plan phase 04 step 1). In-process, at most
// `concurrency` jobs at once (default 2) and at most one GPU job (transcription, image generation).
// Cancel aborts the job's signal; handlers pass it to their child processes (py.ts kills the group).
// Errors are VoxErrors; errors and event payloads go through the redactor (S19).
// Left for phase 04 step 1b: baseVersion + one `batch` with `jobId`, JOB_CONFLICT (needs 02 applyOp).

import type { z } from 'zod';
import { isVoxError, VoxError } from './errors.pending.ts';
import { redactor as sharedRedactor, type Redactor } from './redact.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Serialisable, redacted error of a failed job. */
export interface JobError {
  code: string;
  message: string;
  hint: string;
  details?: Record<string, unknown>;
  /** e.g. the last 40 stderr lines of an external tool */
  cause?: string;
}

export interface JobInfo<R = unknown> {
  id: string;
  kind: string;
  projectId?: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  message?: string;
  result?: R;
  error?: JobError;
}

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  /** Reports progress 0..1 (clamped; non-finite values are ignored). */
  progress(value: number, message?: string): void;
}

export interface JobHandler<A = unknown, R = unknown> {
  /** Validates `start` args (zod), so a bad call fails before it is queued. */
  args?: z.ZodType<A>;
  /** Holds the GPU (at most one such job runs at a time). */
  gpu?: boolean | ((args: A) => boolean);
  run(args: A, ctx: JobContext): Promise<R>;
}

interface JobRef {
  jobId: string;
  kind: string;
  projectId?: string;
}

export interface JobEvents {
  'job.started': JobRef;
  'job.progress': JobRef & { progress: number; message?: string };
  'job.done': JobRef & { result: unknown };
  'job.failed': JobRef & { error: JobError };
  'job.cancelled': JobRef;
}

export type JobEventName = keyof JobEvents;

export interface JobRunner {
  register<A, R>(kind: string, handler: JobHandler<A, R>): void;
  /** Queues a job; returns its id at once. */
  start(kind: string, args: unknown): string;
  get(jobId: string): JobInfo;
  /** Resolves when the job is done, failed or cancelled. */
  wait(jobId: string): Promise<JobInfo>;
  cancel(jobId: string): void;
  /** All jobs, or those whose args carry this `projectId`, in start order. */
  list(projectId?: string): JobInfo[];
  on<E extends JobEventName>(event: E, handler: (payload: JobEvents[E]) => void): () => void;
  kinds(): string[];
}

export interface JobRunnerOptions {
  concurrency?: number;
  redactor?: Redactor;
}

interface Job {
  info: JobInfo;
  args: unknown;
  gpu: boolean;
  handler: JobHandler;
  abort: AbortController;
  done: Promise<JobInfo>;
  settle: (info: JobInfo) => void;
}

function newJobId(): string {
  const time = Date.now().toString(36).padStart(8, '0').slice(-8);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `job_${time}${rand}`;
}

function causeText(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function toJobError(e: unknown, kind: string): JobError {
  const err = isVoxError(e)
    ? e
    : new VoxError(
        'JOB_FAILED',
        `Job ${kind} failed: ${e instanceof Error ? e.message : String(e)}`,
        'Run the job again; if it keeps failing, check logs/engine.log',
        { cause: e },
      );
  const cause = causeText(err.cause);
  return {
    code: err.code,
    message: err.message,
    hint: err.hint,
    ...(err.details === undefined ? {} : { details: err.details }),
    ...(cause === undefined ? {} : { cause }),
  };
}

export function createJobRunner(opts: JobRunnerOptions = {}): JobRunner {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 2));
  const redactor = opts.redactor ?? sharedRedactor;
  const handlers = new Map<string, JobHandler>();
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  const running = new Set<Job>();
  const listeners = new Map<JobEventName, Set<(p: never) => void>>();

  function emit<E extends JobEventName>(event: E, payload: JobEvents[E]): void {
    const set = listeners.get(event);
    if (!set) return;
    const safe = redactor.redact(payload);
    for (const fn of [...set]) {
      try {
        (fn as (p: JobEvents[E]) => void)(safe);
      } catch {
        // A listener bug must not corrupt the runner's state; the job itself is unaffected.
      }
    }
  }

  function ref(job: Job): JobRef {
    const { id, kind, projectId } = job.info;
    return { jobId: id, kind, ...(projectId === undefined ? {} : { projectId }) };
  }

  function snapshot(job: Job): JobInfo {
    return { ...job.info };
  }

  function find(jobId: string): Job {
    const job = jobs.get(jobId);
    if (!job) {
      throw new VoxError('NOT_FOUND', `No job ${jobId}`, 'List jobs to see their ids', {
        details: { jobId },
      });
    }
    return job;
  }

  function finish(job: Job, status: 'done' | 'failed' | 'cancelled', value?: unknown): void {
    job.info.status = status;
    try {
      if (status === 'done') {
        job.info.progress = 1;
        job.info.result = value;
        emit('job.done', { ...ref(job), result: value });
      } else if (status === 'failed') {
        const error = redactor.redact(toJobError(value, job.info.kind));
        job.info.error = error;
        emit('job.failed', { ...ref(job), error });
      } else {
        emit('job.cancelled', ref(job));
      }
    } catch {
      // Building the error failed (e.g. a throwing getter on a thrown value): constant fallback.
      job.info.status = 'failed';
      job.info.error = {
        code: 'JOB_FAILED',
        message: `Job ${job.info.kind} failed`,
        hint: 'Run the job again; if it keeps failing, check logs/engine.log',
      };
    } finally {
      job.settle(snapshot(job));
    }
  }

  function pump(): void {
    for (let i = 0; i < queue.length && running.size < concurrency;) {
      const job = queue[i] as Job;
      const gpuBusy = job.gpu && [...running].some((j) => j.gpu);
      if (gpuBusy) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      // execute settles every job itself (finish never throws), so nothing is lost here.
      void execute(job);
    }
  }

  async function execute(job: Job): Promise<void> {
    running.add(job);
    job.info.status = 'running';
    emit('job.started', ref(job));
    const ctx: JobContext = {
      jobId: job.info.id,
      signal: job.abort.signal,
      progress(value, message) {
        if (job.info.status !== 'running' || !Number.isFinite(value)) return;
        job.info.progress = Math.min(1, Math.max(0, value));
        if (message === undefined) delete job.info.message;
        else job.info.message = redactor.redact(message);
        emit('job.progress', {
          ...ref(job),
          progress: job.info.progress,
          ...(message === undefined ? {} : { message }),
        });
      },
    };
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await job.handler.run(job.args, ctx) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    running.delete(job);
    if (job.abort.signal.aborted) finish(job, 'cancelled');
    else if (outcome.ok) finish(job, 'done', outcome.value);
    else finish(job, 'failed', outcome.error);
    pump();
  }

  return {
    register(kind, handler) {
      if (handlers.has(kind)) {
        throw new VoxError(
          'VALIDATION',
          `Job kind ${kind} is already registered`,
          'Use another kind id',
        );
      }
      handlers.set(kind, handler as JobHandler);
    },

    start(kind, rawArgs) {
      const handler = handlers.get(kind);
      if (!handler) {
        throw new VoxError(
          'VALIDATION',
          `Unknown job kind ${kind}`,
          `Use one of: ${[...handlers.keys()].join(', ')}`,
          {
            details: { kind },
          },
        );
      }
      let args = rawArgs;
      if (handler.args) {
        const res = handler.args.safeParse(rawArgs);
        if (!res.success) {
          throw new VoxError(
            'VALIDATION',
            `Invalid arguments for job ${kind}`,
            'Check the job arguments',
            {
              details: {
                kind,
                issues: res.error.issues.map((i) => ({
                  path: i.path.map(String),
                  message: i.message,
                })),
              },
            },
          );
        }
        args = res.data;
      }
      const gpu = typeof handler.gpu === 'function' ? handler.gpu(args) : handler.gpu === true;
      const projectId =
        typeof args === 'object' &&
        args !== null &&
        typeof (args as { projectId?: unknown }).projectId === 'string'
          ? (args as { projectId: string }).projectId
          : undefined;
      let id = newJobId();
      while (jobs.has(id)) id = newJobId();
      let settle!: (info: JobInfo) => void;
      const done = new Promise<JobInfo>((resolve) => (settle = resolve));
      const job: Job = {
        info: {
          id,
          kind,
          ...(projectId === undefined ? {} : { projectId }),
          status: 'queued',
          progress: 0,
        },
        args,
        gpu,
        handler,
        abort: new AbortController(),
        done,
        settle,
      };
      jobs.set(id, job);
      queue.push(job);
      pump();
      return id;
    },

    get(jobId) {
      return snapshot(find(jobId));
    },

    wait(jobId) {
      try {
        return find(jobId).done;
      } catch (e) {
        return Promise.reject(e as Error);
      }
    },

    cancel(jobId) {
      const job = find(jobId);
      if (job.info.status === 'queued') {
        queue.splice(queue.indexOf(job), 1);
        job.abort.abort();
        finish(job, 'cancelled');
      } else if (job.info.status === 'running') {
        // Status turns `cancelled` once the handler settles (its child process is gone).
        job.abort.abort();
      }
    },

    list(projectId) {
      const all = [...jobs.values()];
      return (
        projectId === undefined ? all : all.filter((j) => j.info.projectId === projectId)
      ).map(snapshot);
    },

    on(event, handler) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      const fn = handler as (p: never) => void;
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },

    kinds() {
      return [...handlers.keys()];
    },
  };
}
