// The quick-clips path (app spec "Quick clips (start screen)"; plan D-11, D-13): create a project,
// import the link or file, then the host's `makeClips` job (shots → transcribe → facetrack → quick
// clips). One progress view: import takes the first 20 %, make clips the rest.
import type { ErrorData, VoxApi } from '../../shared/api.ts';
import type { JobRow, JobsStore } from './jobs.ts';
import { asError } from './store.ts';

export type QuickInput =
  { kind: 'url'; url: string } | { kind: 'file' } | { kind: 'drop'; files: ArrayLike<File> };

export interface QuickOptions {
  count: number;
  minMs: number;
  maxMs: number;
}

export interface QuickProgress {
  progress: number;
  message: string;
}

export type QuickOutcome =
  | {
      ok: true;
      projectId: string;
      sequenceIds: string[];
      requested: number;
      note?: string;
    }
  | { ok: false; projectId?: string; error: ErrorData; cancelled?: boolean };

/** A pasted text must be an http(s) link before any job starts. */
export function isLink(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "4" / "8" seconds → ms, with min ≤ max and 1–600 s each. */
export function lengthRange(minS: number, maxS: number): { minMs: number; maxMs: number } | null {
  if (!Number.isFinite(minS) || !Number.isFinite(maxS)) return null;
  if (minS < 1 || maxS > 600 || minS > maxS) return null;
  return { minMs: Math.round(minS * 1000), maxMs: Math.round(maxS * 1000) };
}

export function projectName(input: QuickInput): string {
  if (input.kind === 'url') {
    try {
      return `Quick clips — ${new URL(input.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return 'Quick clips';
    }
  }
  if (input.kind === 'drop') {
    const f = input.files[0];
    if (f?.name) return f.name.replace(/\.[^.]+$/, '') || 'Quick clips';
  }
  return 'Quick clips';
}

async function importInto(
  vox: VoxApi,
  jobs: JobsStore,
  projectId: string,
  input: QuickInput,
): Promise<JobRow | null> {
  let started: unknown;
  if (input.kind === 'url') started = await vox.media.importUrl(projectId, input.url.trim());
  else if (input.kind === 'file') started = await vox.media.importFiles(projectId);
  else {
    if (!vox.dropFiles) throw { code: 'NOT_AVAILABLE', message: 'Drop is not available', hint: '' };
    started = await vox.dropFiles(projectId, input.files);
  }
  const jobId = (started as { jobId?: string } | null)?.jobId;
  if (!jobId) return null; // the file dialog was cancelled
  return jobs.getState().track(jobId, 'ingest', 'Import');
}

/**
 * Runs the whole path. `projectId` reuses a project made by an earlier attempt (e.g. after
 * `LOGIN_REQUIRED` the user chooses a file instead), so no second empty project is left behind.
 */
export async function makeQuickClips(
  vox: VoxApi,
  jobs: JobsStore,
  input: QuickInput,
  opts: QuickOptions,
  onProgress: (p: QuickProgress) => void,
  projectId?: string,
): Promise<QuickOutcome> {
  let id = projectId;
  try {
    if (!id) id = ((await vox.projects.create(projectName(input))) as { id: string }).id;
    onProgress({ progress: 0.02, message: 'Importing' });
    const unsub = jobs.subscribe((s) => {
      const row = s.rows.find((r) => r.kind === 'ingest' && r.status === 'running');
      if (row)
        onProgress({ progress: 0.02 + row.progress * 0.18, message: row.message ?? 'Importing' });
    });
    let ing: JobRow | null;
    try {
      ing = await importInto(vox, jobs, id, input);
    } finally {
      unsub();
    }
    if (!ing) {
      return {
        ok: false,
        projectId: id,
        cancelled: true,
        error: { code: 'CANCELLED', message: 'No file chosen', hint: '' },
      };
    }
    if (ing.status !== 'done') {
      return {
        ok: false,
        projectId: id,
        error: ing.error ?? { code: 'JOB_FAILED', message: 'Import failed', hint: '' },
      };
    }
    const media =
      (ing.result as { media?: { mediaId: string; kind: string }[] } | undefined)?.media ?? [];
    const video = media.find((m) => m.kind === 'video');
    if (!video) {
      return {
        ok: false,
        projectId: id,
        error: {
          code: 'MEDIA_UNSUPPORTED',
          message: 'That is not a video',
          hint: 'Paste a video link or choose a video file.',
        },
      };
    }
    const jobId = (await vox.jobs.start('makeClips', {
      projectId: id,
      mediaId: video.mediaId,
      count: opts.count,
      minMs: opts.minMs,
      maxMs: opts.maxMs,
    })) as string;
    const unsub2 = jobs.subscribe((s) => {
      const row = s.rows.find((r) => r.id === jobId);
      if (row && row.status === 'running') {
        onProgress({ progress: 0.2 + row.progress * 0.8, message: row.message ?? 'Making clips' });
      }
    });
    let made: JobRow;
    try {
      made = await jobs.getState().track(jobId, 'makeClips', 'Make clips');
    } finally {
      unsub2();
    }
    if (made.status !== 'done') {
      return {
        ok: false,
        projectId: id,
        cancelled: made.status === 'cancelled',
        error: made.error ?? { code: 'JOB_FAILED', message: 'Make clips failed', hint: '' },
      };
    }
    const r = made.result as { sequenceIds: string[]; requested: number; note?: string };
    onProgress({ progress: 1, message: 'Done' });
    return {
      ok: true,
      projectId: id,
      sequenceIds: r.sequenceIds,
      requested: r.requested,
      ...(r.note ? { note: r.note } : {}),
    };
  } catch (e) {
    return { ok: false, ...(id ? { projectId: id } : {}), error: asError(e) };
  }
}

/** The fewer-clips note: the engine's note, else "Only N of M clips fit". */
export function fewerNote(o: {
  sequenceIds: string[];
  requested: number;
  note?: string;
}): string | null {
  if (o.sequenceIds.length >= o.requested) return null;
  const n = o.sequenceIds.length;
  return `Only ${n} of ${o.requested} clips fit in this video at this length${o.note ? ` (${o.note})` : '.'}`;
}
