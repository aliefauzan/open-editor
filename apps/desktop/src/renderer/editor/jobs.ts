// Jobs the UI started (import, make clips, export, audio check, archive search): one row each with
// progress, and on failure the `VoxError` hint and a Retry (app spec "Error handling"). `JOB_CONFLICT`
// rows list the conflicting items (D-15); Retry runs the job again on the current state.
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ErrorData, VoxApi } from '../../shared/api.ts';
import { asError } from './store.ts';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRow {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  progress: number;
  message?: string;
  error?: ErrorData;
  result?: unknown;
  /** Runs the same job again (a new row replaces this one). */
  retry?: () => void;
}

export interface JobsState {
  rows: JobRow[];
  /** Starts an engine job and resolves with its final row (never rejects for a failed job). */
  start(kind: string, args: Record<string, unknown>, label: string): Promise<JobRow>;
  /** Follows a job started elsewhere (e.g. `media.importUrl`). */
  track(jobId: string, kind: string, label: string, retry?: () => void): Promise<JobRow>;
  dismiss(id: string): void;
}

export type JobsStore = StoreApi<JobsState>;

interface JobEvent {
  jobId: string;
  progress?: number;
  message?: string;
  result?: unknown;
  error?: ErrorData;
}

const TERMINAL: Record<string, JobStatus> = {
  'job.done': 'done',
  'job.failed': 'failed',
  'job.cancelled': 'cancelled',
};

/**
 * Entities a `JOB_CONFLICT` names (engine `details.keys`, e.g. `item:seq_a/itm_b`), for the clickable
 * list: items carry their sequence so a click can select them.
 */
export function conflictItems(
  e: ErrorData | undefined,
): { key: string; sequenceId?: string; itemId?: string }[] {
  const keys = (e?.details as { keys?: unknown } | undefined)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys
    .filter((k): k is string => typeof k === 'string')
    .map((key) => {
      const m = /^item:([^/]+)\/(.+)$/.exec(key);
      return m ? { key, sequenceId: m[1]!, itemId: m[2]! } : { key };
    });
}

export function createJobsStore(vox: VoxApi): JobsStore {
  const waiters = new Map<string, (row: JobRow) => void>();
  const store = createStore<JobsState>()((set, get) => {
    const patch = (id: string, p: Partial<JobRow>) => {
      let done: JobRow | undefined;
      set({
        rows: get().rows.map((r) => {
          if (r.id !== id || r.status !== 'running') return r;
          const next = { ...r, ...p };
          if (next.status !== 'running') done = next;
          return next;
        }),
      });
      if (done) {
        waiters.get(id)?.(done);
        waiters.delete(id);
      }
    };
    const on = (name: string) =>
      vox.on(name as never, (raw) => {
        const e = raw as JobEvent;
        if (!get().rows.some((r) => r.id === e.jobId)) return;
        if (name === 'job.progress') {
          return patch(e.jobId, {
            progress: e.progress ?? 0,
            ...(e.message ? { message: e.message } : {}),
          });
        }
        patch(e.jobId, {
          status: TERMINAL[name]!,
          ...(name === 'job.done' ? { progress: 1, result: e.result } : {}),
          ...(e.error ? { error: e.error } : {}),
        });
      });
    for (const n of ['job.progress', 'job.done', 'job.failed', 'job.cancelled']) on(n);

    const track: JobsState['track'] = (jobId, kind, label, retry) => {
      const row: JobRow = {
        id: jobId,
        kind,
        label,
        status: 'running',
        progress: 0,
        ...(retry ? { retry } : {}),
      };
      set({ rows: [...get().rows.filter((r) => r.status === 'running' || r.id !== jobId), row] });
      const done = new Promise<JobRow>((resolve) => waiters.set(jobId, resolve));
      // an event may have come before the row existed: read the job once
      void vox.jobs.get(jobId).then(
        (j) => {
          const info = j as { status?: string; progress?: number; result?: unknown; error?: ErrorData };
          if (info.status && info.status in { done: 1, failed: 1, cancelled: 1 }) {
            patch(jobId, {
              status: info.status as JobStatus,
              progress: info.status === 'done' ? 1 : (info.progress ?? 0),
              ...(info.result === undefined ? {} : { result: info.result }),
              ...(info.error ? { error: info.error } : {}),
            });
          }
        },
        () => undefined,
      );
      return done;
    };

    return {
      rows: [],
      track,
      async start(kind, args, label) {
        const again = () => {
          void get().start(kind, args, label);
        };
        let id: string;
        try {
          id = (await vox.jobs.start(kind, args)) as string;
        } catch (e) {
          const row: JobRow = {
            id: `failed-${Date.now()}`,
            kind,
            label,
            status: 'failed',
            progress: 0,
            error: asError(e),
            retry: again,
          };
          set({ rows: [...get().rows, row] });
          return row;
        }
        return track(id, kind, label, again);
      },
      dismiss(id) {
        set({ rows: get().rows.filter((r) => r.id !== id) });
      },
    };
  });
  return store;
}
