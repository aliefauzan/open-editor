// Sound tags with the real `vox-apple-llm` (local tier, macOS only; D-83): builds the Swift helper,
// ingests the 20 s talking-head fixture and runs the `sounds` job on its extracted audio, asks the
// helper for `speech` on the same audio, and runs it on a synthesized tone. The repo has no fixture
// with laughter or applause, so the reaction answer is checked for shape, not for hits.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SoundsSchema, openEngine, type SoundsJobResult } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { runSounds } from '../../src/stages/sounds.ts';
import { REPO_STYLES } from '../export/project.ts';
import { tempDir } from '../helpers/store.ts';

const repo = new URL('../../../../', import.meta.url).pathname;
const PKG = join(repo, 'native', 'apple-llm');
const BIN = join(PKG, '.build', 'release', 'vox-apple-llm');
const VIDEO = join(repo, 'packages/engine/test/fixtures/assets/media/talking-head-20s.mp4');

const reason = process.platform === 'darwin' ? null : `not macOS (${process.platform})`;
if (reason) console.warn(`sounds.local: skipped: ${reason}`);

function windowsShape(w: { startMs: number; endMs: number; labels: unknown[] }[], endMs: number) {
  for (const x of w) {
    expect(x.startMs).toBeGreaterThanOrEqual(0);
    expect(x.endMs).toBeGreaterThan(x.startMs);
    expect(x.endMs).toBeLessThanOrEqual(endMs + 1500);
    expect(x.labels.length).toBeGreaterThan(0);
  }
}

describe.skipIf(reason !== null)('sounds (real helper, local)', () => {
  test('the talking-head fixture: the job stores a valid answer; `speech` is found', async () => {
    const build = spawnSync('swift', ['build', '-c', 'release', '--package-path', PKG], {
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`swift build failed:\n${build.stderr}`);
    const status = spawnSync(BIN, ['--status'], { encoding: 'utf8' });
    expect(JSON.parse(status.stdout)).toMatchObject({ sounds: true });

    const e = openEngine({
      projectsDir: join(tempDir('vox-snd-local-'), 'Projects'),
      stylesDirs: [REPO_STYLES],
      config: async () => ({}),
      appleHelper: { command: BIN },
    });
    const p = await e.createProject('sounds');
    const ing = (await e.jobs.wait(
      e.jobs.start('ingest', { projectId: p.id, inputs: [VIDEO], actor: 'cli' }),
    )) as JobInfo<{ media: { mediaId: string }[] }>;
    expect(ing.status, JSON.stringify(ing.error)).toBe('done');
    const mediaId = ing.result!.media[0]!.mediaId;
    const t0 = Date.now();
    const job = (await e.jobs.wait(
      e.jobs.start('sounds', { projectId: p.id, mediaId, actor: 'cli' }),
    )) as JobInfo<SoundsJobResult>;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const r = job.result!;
    if (!r.available) throw new Error(`not available: ${r.reason}`);
    console.info(`sounds.local: ${Date.now() - t0} ms, ${JSON.stringify(r)}`);
    const m = (await e.getProject(p.id)).media.find((x) => x.id === mediaId)!;
    const s = SoundsSchema.parse(
      JSON.parse(await readFile(join(e.projectsDir, p.id, r.soundsPath), 'utf8')),
    );
    expect(s.windowMs).toBe(1500);
    windowsShape(s.windows, m.durationMs!);

    // the same audio asked for speech: the fixture is `say` speech
    const audio = join(e.projectsDir, p.id, m.audioPath!);
    const speech = spawnSync(BIN, ['--sounds'], {
      input: JSON.stringify({ audioPath: audio, classes: ['speech'] }),
      encoding: 'utf8',
    });
    expect(speech.status, speech.stderr).toBe(0);
    const a = JSON.parse(speech.stdout) as {
      windows: { startMs: number; endMs: number; labels: { id: string }[] }[];
    };
    expect(a.windows.length).toBeGreaterThan(3);
    expect(a.windows.every((w) => w.labels[0]!.id === 'speech')).toBe(true);
  }, 600_000);

  test('a synthesized tone: no crash, a valid answer', async () => {
    const dir = tempDir('vox-snd-tone-');
    const tone = join(dir, 'tone.m4a');
    const ff = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=6',
        '-c:a',
        'aac',
        '-f',
        'mp4',
        tone,
      ],
      { encoding: 'utf8' },
    );
    if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr}`);
    const r = await runSounds({ command: BIN }, tone, { timeoutMs: 60_000 });
    if (!r.available) throw new Error(`not available: ${r.reason}`);
    expect(r.sounds.windowMs).toBe(1500);
    windowsShape(r.sounds.windows, 6000);
    // a bad class id is a bad request, not a crash
    const bad = spawnSync(BIN, ['--sounds'], {
      input: JSON.stringify({ audioPath: tone, classes: ['not_a_class'] }),
      encoding: 'utf8',
    });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ error: { code: 'badRequest' } });
  }, 120_000);
});
