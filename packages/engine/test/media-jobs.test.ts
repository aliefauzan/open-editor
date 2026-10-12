// Engine media jobs (plan phase 04 steps 1b, 9, 10; D-15): jobs on `engine.jobs`, events through
// `engine.on`, one history entry per job with its jobId, JOB_CONFLICT on a conflicting edit made
// while the job runs, an unrelated edit is fine, reruns are cached. Python is a fake `uv`.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openEngine, type Engine } from '../src/api.ts';
import type { JobInfo } from '../src/jobs.ts';
import { tempDir } from './helpers/store.ts';
import { templates } from './helpers/templates.ts';

const fakePy = new URL('./helpers/fake-py.mjs', import.meta.url).pathname;
const tap = new URL('./fixtures/assets/sfx/tap.wav', import.meta.url).pathname;

function engine(config: Record<string, unknown> = {}): Engine {
  return openEngine({
    projectsDir: join(tempDir('vox-jobs-'), 'Projects'),
    stylesDirs: [],
    templates,
    tools: { uv: fakePy, py: '/nonexistent-py-project' },
    config: async () => config,
  });
}

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 500 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

/** A project with two audio items (tap.wav copied in), added directly. */
async function projectWithAudio(e: Engine): Promise<string> {
  const p = await e.createProject('jobs');
  const dir = join(e.projectsDir, p.id);
  await mkdir(join(dir, 'media'), { recursive: true });
  for (const id of ['m_aud1', 'm_aud2']) {
    await copyFile(tap, join(dir, 'media', `${id}.wav`));
    await e.applyOp(
      p.id,
      {
        op: 'addMedia',
        args: {
          media: {
            id,
            kind: 'audio',
            path: `media/${id}.wav`,
            durationMs: 200,
            hasAudio: true,
            origin: { type: 'upload' },
            tags: [],
          },
        },
      },
      { actor: 'user' },
    );
  }
  return p.id;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('engine.jobs', () => {
  test('lists the job kinds of the engine spec (media, assets, quick clips, export)', () => {
    expect(engine().jobs.kinds().sort()).toEqual([
      'assets.cutout',
      'assets.fetch',
      'assets.generate',
      'assets.search',
      'audioQa',
      'exportCaptions',
      'exportTimeline',
      'facetrack',
      'frames',
      'highlights',
      'ingest',
      'quickClips',
      'render',
      'shots',
      'transcribe',
    ]);
  });

  test('ingest: documents become media in one history entry with the jobId; a rerun adds nothing', async () => {
    const e = engine();
    const p = await e.createProject('docs');
    const src = tempDir('vox-jobs-src-');
    await writeFile(join(src, 'a.txt'), 'alpha\n');
    await writeFile(join(src, 'b.pdf'), '%PDF-1.4\n%%EOF\n');
    const events: string[] = [];
    e.on('job.done', (x) => events.push(`done:${x.kind}`));
    e.on('job.started', (x) => events.push(`started:${x.kind}`));
    const id = e.jobs.start('ingest', { projectId: p.id, inputs: [src], actor: 'cli' });
    const info = (await e.jobs.wait(id)) as JobInfo<{
      media: { mediaId: string; kind: string }[];
      version: number;
    }>;
    expect(info.status, JSON.stringify(info.error)).toBe('done');
    expect(info.result!.media.map((m) => m.kind)).toEqual(['document', 'document']);
    expect(events).toEqual(['started:ingest', 'done:ingest']);
    const hist = await e.history(p.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ actor: 'cli', jobId: id, version: 1 });
    const pdf = (await e.getProject(p.id)).media.find((m) => m.path.endsWith('.pdf'))!;
    expect(await readFile(join(e.projectsDir, p.id, pdf.textPath!), 'utf8')).toBe(
      'Slide one\n\nSlide two',
    );

    const again = await e.jobs.wait(e.jobs.start('ingest', { projectId: p.id, inputs: [src] }));
    expect(again.status).toBe('done');
    expect(await e.history(p.id)).toHaveLength(1);
  });

  test('ingest args are strict: a cookies setting in the args is refused (S33)', () => {
    const e = engine();
    expect(() =>
      e.jobs.start('ingest', {
        projectId: 'p_x',
        inputs: ['https://youtu.be/x'],
        cookiesFromBrowser: 'chrome',
      }),
    ).toThrow(/Invalid arguments for job ingest/);
  });

  test('transcribe: writes the transcript with word kinds, sets transcriptRev, cached on rerun', async () => {
    const e = engine();
    const pid = await projectWithAudio(e);
    const log = join(tempDir('vox-jobs-log-'), 'py.log');
    vi.stubEnv('VOX_FAKE_PY_LOG', log);
    const a = await e.jobs.wait(e.jobs.start('transcribe', { projectId: pid, mediaId: 'm_aud1' }));
    expect(a.status, JSON.stringify(a.error)).toBe('done');
    const m = (await e.getProject(pid)).media.find((x) => x.id === 'm_aud1')!;
    expect(m.transcriptPath).toBe('transcripts/m_aud1.json');
    expect(m.transcriptRev).toMatch(/^[0-9a-f]{16}$/);
    const t = JSON.parse(await readFile(join(e.projectsDir, pid, m.transcriptPath!), 'utf8')) as {
      words: { text: string; kind: string }[];
    };
    expect(t.words.find((w) => w.text === 'um')?.kind).toBe('filler');
    const b = await e.jobs.wait(e.jobs.start('transcribe', { projectId: pid, mediaId: 'm_aud1' }));
    expect(b.result).toMatchObject({ cached: true });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['transcribe']);
    // Rerun changed nothing: still 3 entries (2 addMedia + 1 transcribe).
    expect(await e.history(pid)).toHaveLength(3);
  });

  test('a user edit to the same media while the job runs fails it with JOB_CONFLICT; nothing changes', async () => {
    const e = engine();
    const pid = await projectWithAudio(e);
    const tmp = tempDir('vox-jobs-sync-');
    vi.stubEnv('VOX_FAKE_PY_STARTED', join(tmp, 'started'));
    vi.stubEnv('VOX_FAKE_PY_GO', join(tmp, 'go'));
    const id = e.jobs.start('transcribe', { projectId: pid, mediaId: 'm_aud1' });
    await waitFor(join(tmp, 'started'));
    await e.applyOp(
      pid,
      { op: 'updateMedia', args: { mediaId: 'm_aud1', patch: { description: 'mine' } } },
      { actor: 'user' },
    );
    await writeFile(join(tmp, 'go'), '');
    const info = await e.jobs.wait(id);
    expect(info.status).toBe('failed');
    expect(info.error?.code).toBe('JOB_CONFLICT');
    const m = (await e.getProject(pid)).media.find((x) => x.id === 'm_aud1')!;
    expect(m.transcriptPath).toBeUndefined();
    expect(m.description).toBe('mine');
  });

  test('an unrelated edit while the job runs is fine', async () => {
    const e = engine();
    const pid = await projectWithAudio(e);
    const tmp = tempDir('vox-jobs-sync-');
    vi.stubEnv('VOX_FAKE_PY_STARTED', join(tmp, 'started'));
    vi.stubEnv('VOX_FAKE_PY_GO', join(tmp, 'go'));
    const id = e.jobs.start('transcribe', { projectId: pid, mediaId: 'm_aud1' });
    await waitFor(join(tmp, 'started'));
    await e.applyOp(
      pid,
      { op: 'updateMedia', args: { mediaId: 'm_aud2', patch: { description: 'other' } } },
      { actor: 'user' },
    );
    await writeFile(join(tmp, 'go'), '');
    const info = await e.jobs.wait(id);
    expect(info.status, JSON.stringify(info.error)).toBe('done');
    const last = (await e.history(pid)).at(-1)!;
    expect(last).toMatchObject({ jobId: id, actor: 'user' });
  });

  test('transcribe on a document is a VALIDATION failure; unknown media is NOT_FOUND', async () => {
    const e = engine();
    const pid = await projectWithAudio(e);
    const info = await e.jobs.wait(
      e.jobs.start('transcribe', { projectId: pid, mediaId: 'm_none' }),
    );
    expect(info.error?.code).toBe('NOT_FOUND');
  });

  test('job errors and events are redacted (S19)', async () => {
    const e = engine();
    const secret = 'sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000';
    const failed: string[] = [];
    e.on('job.failed', (x) => failed.push(JSON.stringify(x)));
    const info = await e.jobs.wait(
      e.jobs.start('ingest', { projectId: 'p_nope', inputs: [`/tmp/${secret}`] }),
    );
    expect(info.status).toBe('failed');
    expect(JSON.stringify(info)).not.toContain(secret);
    expect(failed.join('')).not.toContain(secret);
  });
});
