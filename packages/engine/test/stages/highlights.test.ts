// The `highlights` job (D-75) with a fake `vox-apple-llm --highlights`: it reads the proxy only,
// stores cache/highlights/<id>.json without changing the project, serves a rerun from the file;
// "not available" (no helper, `unavailable`, an old helper, no proxy) finishes the job without a
// file; a failed analysis, a bad answer or a timeout fails it with TOOL_FAILED.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeOfflineProject } from '../../../../scripts/make-offline-project.ts';
import {
  HighlightsSchema,
  openEngine,
  type Engine,
  type HighlightsJobResult,
  type NativeHelper,
} from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { highlightsTimeoutMs, runHighlights } from '../../src/stages/highlights.ts';
import { REPO_STYLES } from '../export/project.ts';
import { tempDir } from '../helpers/store.ts';

const FAKE = new URL('../helpers/fake-apple-highlights.mjs', import.meta.url).pathname;
const fake = (mode: string, log?: string): NativeHelper => ({
  command: process.execPath,
  args: [FAKE],
  env: { VOX_FAKE_HIGHLIGHTS: mode, ...(log ? { VOX_FAKE_HIGHLIGHTS_LOG: log } : {}) },
});

const newEngine = (appleHelper?: NativeHelper): Engine =>
  openEngine({
    projectsDir: join(tempDir('vox-hl-'), 'Projects'),
    stylesDirs: [REPO_STYLES],
    config: async () => ({}),
    ...(appleHelper ? { appleHelper } : {}),
  });

async function highlights(
  e: Engine,
  projectId: string,
  mediaId: string,
): Promise<JobInfo<HighlightsJobResult>> {
  return (await e.jobs.wait(
    e.jobs.start('highlights', { projectId, mediaId, actor: 'cli' }),
  )) as JobInfo<HighlightsJobResult>;
}

describe('highlights job (fake helper)', () => {
  test('available: stores the answer, the project is unchanged, a rerun is cached', async () => {
    const log = join(tempDir('vox-hl-log-'), 'args.jsonl');
    const e = newEngine(fake('ok', log));
    const o = await makeOfflineProject(e);
    const before = await e.getProject(o.projectId);
    const job = await highlights(e, o.projectId, o.mediaId);
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.result).toEqual({
      mediaId: o.mediaId,
      available: true,
      highlightsPath: `cache/highlights/${o.mediaId}.json`,
      highlights: 1,
      keyFrameMs: 4000,
      cached: false,
    });
    const stored = HighlightsSchema.parse(
      JSON.parse(readFileSync(join(o.dir, 'cache', 'highlights', `${o.mediaId}.json`), 'utf8')),
    );
    expect(stored.highlights).toEqual([{ startMs: 4500, endMs: 14500 }]);
    expect(stored.levels).toHaveLength(40);
    expect(await e.getProject(o.projectId)).toEqual(before);
    const m = before.media.find((x) => x.id === o.mediaId)!;
    // the helper got the proxy, never the original
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('--highlights');
    expect(calls[0]![1]!.endsWith(`/${o.projectId}/${m.proxyPath!}`)).toBe(true);
    expect(m.proxyPath).not.toBe(m.path);

    const again = await highlights(e, o.projectId, o.mediaId);
    expect(again.result).toMatchObject({ available: true, cached: true });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 60_000);

  test('a partial answer (key frame failed) is stored with keyFrameMs null', async () => {
    const e = newEngine(fake('partial'));
    const o = await makeOfflineProject(e);
    const job = await highlights(e, o.projectId, o.mediaId);
    expect(job.result).toMatchObject({ available: true, highlights: 1, keyFrameMs: null });
  }, 60_000);

  test('not available: no helper, `unavailable`, an old helper, no proxy → done, nothing changed', async () => {
    for (const helper of [undefined, fake('unavailable'), fake('old')]) {
      const e = newEngine(helper);
      const o = await makeOfflineProject(e);
      const before = await e.getProject(o.projectId);
      const job = await highlights(e, o.projectId, o.mediaId);
      expect(job.status, JSON.stringify(job.error)).toBe('done');
      expect(job.result).toMatchObject({ available: false });
      expect((job.result as { reason: string }).reason.length).toBeGreaterThan(0);
      expect(await e.getProject(o.projectId)).toEqual(before);
      expect(existsSync(join(o.dir, 'cache', 'highlights'))).toBe(false);
    }
    const e = newEngine(fake('ok'));
    const o = await makeOfflineProject(e);
    await e.applyOp(
      o.projectId,
      { op: 'updateMedia', args: { mediaId: o.mediaId, patch: { proxyPath: null } } } as never,
      { actor: 'cli' },
    );
    const job = await highlights(e, o.projectId, o.mediaId);
    expect(job.result).toEqual({
      mediaId: o.mediaId,
      available: false,
      reason: 'the media has no preview proxy',
    });
  }, 120_000);

  test('a failed analysis or a bad answer fails the job with TOOL_FAILED and stores nothing', async () => {
    for (const mode of ['error', 'garbage', 'invalid']) {
      const e = newEngine(fake(mode));
      const o = await makeOfflineProject(e);
      const job = await highlights(e, o.projectId, o.mediaId);
      expect(job.status, mode).toBe('failed');
      expect(job.error?.code, mode).toBe('TOOL_FAILED');
      expect(existsSync(join(o.dir, 'cache', 'highlights'))).toBe(false);
    }
  }, 120_000);

  test('it takes no job slot: it runs while both slots are busy', async () => {
    const e = newEngine(fake('ok'));
    const o = await makeOfflineProject(e);
    // two quick-clips jobs that wait on a scorer hold both slots
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    e.quickClips.registerScorer('slow', async (input) => {
      await held;
      return input.candidates.map(() => 0);
    });
    const args = { projectId: o.projectId, mediaId: o.mediaId, count: 1, minMs: 4000, maxMs: 8000 };
    const q = [e.jobs.start('quickClips', args), e.jobs.start('quickClips', args)];
    const job = await highlights(e, o.projectId, o.mediaId);
    expect(job.status).toBe('done');
    expect(q.map((id) => e.jobs.get(id).status)).toEqual(['running', 'running']);
    release();
    await Promise.all(q.map((id) => e.jobs.wait(id)));
  }, 60_000);
});

describe('runHighlights', () => {
  test('a hung helper is killed at the time limit (TOOL_FAILED); an abort is CANCELLED', async () => {
    await expect(runHighlights(fake('hang'), '/v.mp4', { timeoutMs: 300 })).rejects.toMatchObject({
      code: 'TOOL_FAILED',
    });
    const ac = new AbortController();
    const p = runHighlights(fake('hang'), '/v.mp4', { timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('a helper that does not start is "not available"', async () => {
    const r = await runHighlights({ command: '/nonexistent/vox-apple-llm' }, '/v.mp4', {
      timeoutMs: 5000,
    });
    expect(r).toEqual({ available: false, reason: expect.stringMatching(/did not start/) });
  });

  test('time limit: 2 min plus half the video', () => {
    expect(highlightsTimeoutMs(0)).toBe(120_000);
    expect(highlightsTimeoutMs(900_000)).toBe(570_000);
  });
});
