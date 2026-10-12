// The `sounds` job (D-83) with a fake `vox-apple-llm --sounds`: it sends the extracted audio and
// the reaction classes on stdin, stores cache/sounds/<id>.json without changing the project and
// serves a rerun from the file; "not available" (no helper, `unavailable`, an old helper, no audio)
// finishes the job without a file; a failed analysis, a crash, a bad answer or a timeout fails it
// with TOOL_FAILED.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeOfflineProject } from '../../../../scripts/make-offline-project.ts';
import {
  REACTION_CLASSES,
  SoundsSchema,
  openEngine,
  type Engine,
  type NativeHelper,
  type SoundsJobResult,
} from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { SOUND_MIN_CONFIDENCE, runSounds, soundsTimeoutMs } from '../../src/stages/sounds.ts';
import { REPO_STYLES } from '../export/project.ts';
import { tempDir } from '../helpers/store.ts';

const FAKE = new URL('../helpers/fake-apple-sounds.mjs', import.meta.url).pathname;
const fake = (mode: string, log?: string): NativeHelper => ({
  command: process.execPath,
  args: [FAKE],
  env: { VOX_FAKE_SOUNDS: mode, ...(log ? { VOX_FAKE_SOUNDS_LOG: log } : {}) },
});

const newEngine = (appleHelper?: NativeHelper): Engine =>
  openEngine({
    projectsDir: join(tempDir('vox-snd-'), 'Projects'),
    stylesDirs: [REPO_STYLES],
    config: async () => ({}),
    ...(appleHelper ? { appleHelper } : {}),
  });

async function sounds(
  e: Engine,
  projectId: string,
  mediaId: string,
): Promise<JobInfo<SoundsJobResult>> {
  return (await e.jobs.wait(
    e.jobs.start('sounds', { projectId, mediaId, actor: 'cli' }),
  )) as JobInfo<SoundsJobResult>;
}

const calls = (log: string) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { args: string[]; request: Record<string, unknown> });

describe('sounds job (fake helper)', () => {
  test('available: stores the answer, the project is unchanged, a rerun is cached', async () => {
    const log = join(tempDir('vox-snd-log-'), 'calls.jsonl');
    const e = newEngine(fake('ok', log));
    const o = await makeOfflineProject(e);
    const before = await e.getProject(o.projectId);
    const job = await sounds(e, o.projectId, o.mediaId);
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.result).toEqual({
      mediaId: o.mediaId,
      available: true,
      soundsPath: `cache/sounds/${o.mediaId}.json`,
      windows: 2,
      cached: false,
    });
    const file = join(o.dir, 'cache', 'sounds', `${o.mediaId}.json`);
    const stored = SoundsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(stored.windows[0]).toEqual({
      startMs: 6000,
      endMs: 7500,
      labels: [{ id: 'laughter', confidence: 0.8 }],
    });
    expect(stored.classes).toEqual([...REACTION_CLASSES]);
    expect(stored.minConfidence).toBe(SOUND_MIN_CONFIDENCE);
    expect(await e.getProject(o.projectId)).toEqual(before);
    // the helper got the extracted audio and the reaction classes on stdin
    const m = before.media.find((x) => x.id === o.mediaId)!;
    const c = calls(log);
    expect(c).toHaveLength(1);
    expect(c[0]!.args).toEqual(['--sounds']);
    expect(c[0]!.request).toEqual({
      audioPath: expect.stringMatching(new RegExp(`/${o.projectId}/${m.audioPath!}$`)),
      classes: [...REACTION_CLASSES],
      windowSec: 1.5,
      minConfidence: SOUND_MIN_CONFIDENCE,
    });

    const again = await sounds(e, o.projectId, o.mediaId);
    expect(again.result).toMatchObject({ available: true, cached: true });
    expect(calls(log)).toHaveLength(1);

    // a file asked with other classes (an older engine) is recomputed
    writeFileSync(file, JSON.stringify({ ...stored, classes: ['laughter'] }));
    const third = await sounds(e, o.projectId, o.mediaId);
    expect(third.result).toMatchObject({ available: true, cached: false });
    expect(calls(log)).toHaveLength(2);
  }, 60_000);

  test('not available: no helper, `unavailable`, an old helper, no audio → done, nothing changed', async () => {
    for (const helper of [undefined, fake('unavailable'), fake('old')]) {
      const e = newEngine(helper);
      const o = await makeOfflineProject(e);
      const before = await e.getProject(o.projectId);
      const job = await sounds(e, o.projectId, o.mediaId);
      expect(job.status, JSON.stringify(job.error)).toBe('done');
      expect(job.result).toMatchObject({ available: false });
      expect((job.result as { reason: string }).reason.length).toBeGreaterThan(0);
      expect(await e.getProject(o.projectId)).toEqual(before);
      expect(existsSync(join(o.dir, 'cache', 'sounds'))).toBe(false);
    }
    const e = newEngine(fake('ok'));
    const o = await makeOfflineProject(e);
    await e.applyOp(
      o.projectId,
      { op: 'updateMedia', args: { mediaId: o.mediaId, patch: { audioPath: null } } } as never,
      { actor: 'cli' },
    );
    const job = await sounds(e, o.projectId, o.mediaId);
    expect(job.result).toEqual({
      mediaId: o.mediaId,
      available: false,
      reason: 'the media has no extracted audio',
    });
  }, 120_000);

  test('a failed analysis, a crash or a bad answer fails the job with TOOL_FAILED and stores nothing', async () => {
    for (const mode of ['error', 'crash', 'garbage', 'invalid']) {
      const e = newEngine(fake(mode));
      const o = await makeOfflineProject(e);
      const job = await sounds(e, o.projectId, o.mediaId);
      expect(job.status, mode).toBe('failed');
      expect(job.error?.code, mode).toBe('TOOL_FAILED');
      expect(existsSync(join(o.dir, 'cache', 'sounds'))).toBe(false);
    }
  }, 120_000);
});

describe('runSounds', () => {
  test('a hung helper is killed at the time limit (TOOL_FAILED); an abort is CANCELLED', async () => {
    await expect(runSounds(fake('hang'), '/a.m4a', { timeoutMs: 300 })).rejects.toMatchObject({
      code: 'TOOL_FAILED',
    });
    const ac = new AbortController();
    const p = runSounds(fake('hang'), '/a.m4a', { timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('a helper that does not start is "not available"; no helper is "not available"', async () => {
    const r = await runSounds({ command: '/nonexistent/vox-apple-llm' }, '/a.m4a', {
      timeoutMs: 5000,
    });
    expect(r).toEqual({ available: false, reason: expect.stringMatching(/did not start/) });
    expect(await runSounds(undefined, '/a.m4a', { timeoutMs: 5000 })).toMatchObject({
      available: false,
    });
  });

  test('an answer with no reaction is available with no windows', async () => {
    const r = await runSounds(fake('empty'), '/a.m4a', { timeoutMs: 10_000 });
    expect(r).toMatchObject({ available: true, sounds: { windows: [], windowMs: 1500 } });
  });

  test('time limit: 1 min plus a tenth of the audio', () => {
    expect(soundsTimeoutMs(0)).toBe(60_000);
    expect(soundsTimeoutMs(600_000)).toBe(120_000);
  });
});
