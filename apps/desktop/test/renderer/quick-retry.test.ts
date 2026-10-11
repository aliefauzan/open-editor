// GATE 5 finding: after a failed "Make clips" (exit 134 in transcribe), pressing Make clips again
// worked, but the editor still showed the old "Make clips failed" row. A successful run clears the
// failed import / make-clips rows of earlier attempts; a failed run keeps them.
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { VoxApi } from '../../src/shared/api.ts';
import type { JobRow, JobsState } from '../../src/renderer/editor/jobs.ts';
import { makeQuickClips } from '../../src/renderer/editor/quick-flow.ts';

const failed = (id: string, kind: string): JobRow => ({
  id,
  kind,
  label: kind,
  status: 'failed',
  progress: 0,
  error: { code: 'JOB_FAILED', message: 'Python tool transcribe failed (exit code 134)', hint: '' },
});

function setup(makeClips: JobRow['status']) {
  const jobs = createStore<JobsState>()((set, get) => ({
    rows: [
      failed('old-make', 'makeClips'),
      failed('old-ingest', 'ingest'),
      failed('exp', 'export'),
    ],
    start: () => Promise.reject(new Error('unused')),
    track: async (id, kind, label) => {
      const row: JobRow =
        kind === 'ingest'
          ? {
              id,
              kind,
              label,
              status: 'done',
              progress: 1,
              result: { media: [{ mediaId: 'm1', kind: 'video' }] },
            }
          : makeClips === 'done'
            ? {
                id,
                kind,
                label,
                status: 'done',
                progress: 1,
                result: { sequenceIds: ['s1'], requested: 1 },
              }
            : failed(id, kind);
      set({ rows: [...get().rows, row] });
      return row;
    },
    dismiss: (id) => set({ rows: get().rows.filter((r) => r.id !== id) }),
  }));
  const vox = {
    media: { importUrl: async () => ({ jobId: 'j-ing' }) },
    jobs: { start: async () => 'j-make' },
  } as unknown as VoxApi;
  const run = () =>
    makeQuickClips(
      vox,
      jobs,
      { kind: 'url', url: 'https://youtu.be/x' },
      { count: 1, minMs: 30_000, maxMs: 60_000 },
      () => {},
      'p1',
    );
  return { jobs, run };
}

describe('quick clips retry', () => {
  it('a successful run clears failed rows of earlier attempts, not other kinds', async () => {
    const { jobs, run } = setup('done');
    expect((await run()).ok).toBe(true);
    const ids = jobs.getState().rows.map((r) => r.id);
    expect(ids).not.toContain('old-make');
    expect(ids).not.toContain('old-ingest');
    expect(ids).toContain('exp');
  });

  it('a failed run keeps the failed rows', async () => {
    const { jobs, run } = setup('failed');
    expect((await run()).ok).toBe(false);
    expect(jobs.getState().rows.map((r) => r.id)).toEqual(
      expect.arrayContaining(['old-make', 'old-ingest', 'j-make']),
    );
  });
});

describe('quick clips drop (GATE 5 finding)', () => {
  // A dropped FileList does not survive Electron's contextBridge (the preload saw no files, the flow
  // read that as "cancelled" and left an empty project with no message). The renderer hands over a
  // plain array of File objects, and a drop that yields nothing is an error the user sees.
  function dropSetup(dropResult: unknown) {
    const seen: unknown[] = [];
    const jobs = createStore<JobsState>()((set, get) => ({
      rows: [],
      start: () => Promise.reject(new Error('unused')),
      track: async (id, kind, label) => {
        const row: JobRow = { id, kind, label, status: 'done', progress: 1, result: { media: [] } };
        set({ rows: [...get().rows, row] });
        return row;
      },
      dismiss: (id) => set({ rows: get().rows.filter((r) => r.id !== id) }),
    }));
    const vox = {
      dropFiles: async (_p: string, files: unknown) => {
        seen.push(files);
        return dropResult;
      },
      jobs: { start: async () => 'j-make' },
    } as unknown as VoxApi;
    const file = new File(['x'], 'cuts-2shot.mp4', { type: 'video/mp4' });
    const list = { 0: file, length: 1, item: () => file } as unknown as FileList;
    const run = () =>
      makeQuickClips(
        vox,
        jobs,
        { kind: 'drop', files: list },
        { count: 1, minMs: 2000, maxMs: 5000 },
        () => {},
        'p1',
      );
    return { run, seen, file };
  }

  it('hands the preload a plain array of the dropped File objects', async () => {
    const { run, seen, file } = dropSetup({ jobId: 'j-ing' });
    await run();
    expect(Array.isArray(seen[0])).toBe(true);
    expect(seen[0]).toEqual([file]);
  });

  it('a drop that yields no job is an error, not a silent cancel', async () => {
    const { run } = dropSetup(null);
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.cancelled).toBeFalsy();
    expect(out.ok === false && out.error.message).toMatch(/could not be read/i);
  });
});
