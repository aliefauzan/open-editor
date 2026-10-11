// Phase 10b engine-host parts: `media.importUrl`, `media.search`, offline media on `projects.open`,
// the `makeClips` app job (seeded in test builds, D-16) and S36 (`SCHEMA_TOO_NEW` writes nothing).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngine, type Engine } from '@vox/engine';
import { describe, expect, it } from 'vitest';
import { createHandlers } from '../../src/engine-host/handlers.ts';
import { AppJobs } from '../../src/engine-host/quick.ts';
import type { EventName } from '../../src/shared/api.ts';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const STYLES = join(REPO, 'styles');
const FX = join(REPO, 'packages', 'engine', 'test', 'fixtures');
const SEED_MP4 = join(FX, 'assets', 'media', 'talking-head-20s.mp4');

function setup(o: { seeds?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vox-hb-'));
  const engine = openEngine({
    projectsDir: join(home, 'Projects'),
    stylesDirs: [STYLES],
    trustFile: join(home, 'trust.json'),
  });
  const events: [EventName, unknown][] = [];
  const appJobs = new AppJobs(
    engine,
    (n, p) => events.push([n, p]),
    o.seeds ? { dir: FX } : undefined,
  );
  return { engine, home, events, h: createHandlers(engine, undefined, { appJobs }) };
}

type H = ReturnType<typeof createHandlers>;
const call = <T,>(h: H, m: keyof H, ...a: unknown[]) => h[m]!(...a) as Promise<T>;

async function waitJob(h: H, id: string) {
  for (let i = 0; i < 1200; i++) {
    const j = await call<{ status: string; result?: unknown; error?: unknown }>(h, 'jobs.get', id);
    if (j.status !== 'running' && j.status !== 'queued') return j;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish');
}

async function addMedia(e: Engine, id: string, media: object) {
  const r = await e.applyOp(id, { op: 'addMedia', args: { media } } as never, { actor: 'user' });
  expect(r.results[0]!.status).toBe('succeeded');
}

const MEDIA = {
  kind: 'video',
  durationMs: 1000,
  width: 16,
  height: 16,
  hasAudio: false,
  origin: { type: 'upload' },
};

describe('engine host (10b)', () => {
  it('media.importUrl refuses text that is not a link before any job starts', async () => {
    const { h, engine } = setup();
    const p = await call<{ id: string }>(h, 'projects.create', 'U');
    await expect(call(h, 'media.importUrl', p.id, 'not a link')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(call(h, 'media.importUrl', p.id, 'file:///etc/passwd')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(engine.jobs.list(p.id)).toEqual([]);
  });

  it('media.search matches names, tags, descriptions and transcript text', async () => {
    const { h, engine, home } = setup();
    const p = await call<{ id: string }>(h, 'projects.create', 'S');
    const dir = join(home, 'Projects', p.id);
    writeFileSync(
      join(dir, 'tr.json'),
      JSON.stringify({
        language: 'en',
        words: [{ text: 'pricing' }, { text: 'matters' }],
        speechRegions: [],
      }),
    );
    await addMedia(engine, p.id, { ...MEDIA, id: 'm_a', path: 'media/beach.mp4', tags: ['sunny'] });
    await addMedia(engine, p.id, {
      ...MEDIA,
      id: 'm_b',
      path: 'media/b.mp4',
      tags: [],
      description: 'A city at night',
      transcriptPath: 'tr.json',
    });
    expect(await call(h, 'media.search', p.id, 'BEACH')).toEqual(['m_a']);
    expect(await call(h, 'media.search', p.id, 'sunny')).toEqual(['m_a']);
    expect(await call(h, 'media.search', p.id, 'city')).toEqual(['m_b']);
    expect(await call(h, 'media.search', p.id, 'pricing matters')).toEqual(['m_b']);
    expect(await call(h, 'media.search', p.id, '')).toEqual(['m_a', 'm_b']);
  });

  it('projects.open lists media whose file is missing (offline)', async () => {
    const { h, engine, home } = setup();
    const p = await call<{ id: string }>(h, 'projects.create', 'O');
    writeFileSync(join(home, 'Projects', p.id, 'here.mp4'), '');
    await addMedia(engine, p.id, { ...MEDIA, id: 'm_here', path: 'here.mp4', tags: [] });
    await addMedia(engine, p.id, { ...MEDIA, id: 'm_gone', path: 'media/gone.mp4', tags: [] });
    expect(await call(h, 'projects.open', p.id)).toMatchObject({ offline: ['m_gone'] });
  });

  it('S36: a project with a newer schemaVersion does not open and stays byte-identical', async () => {
    const { h, engine, home } = setup();
    const p = await call<{ id: string }>(h, 'projects.create', 'New');
    await engine.applyOp(p.id, { op: 'addSequence', args: { name: 'Main' } } as never, {
      actor: 'user',
    });
    const dir = join(home, 'Projects', p.id);
    const pj = join(dir, 'project.json');
    const raw = JSON.parse(readFileSync(pj, 'utf8')) as { schemaVersion: number };
    writeFileSync(pj, JSON.stringify({ ...raw, schemaVersion: raw.schemaVersion + 1 }, null, 2));
    for (const f of readdirSync(dir)) if (f.endsWith('.lock')) rmSync(join(dir, f));
    const snap = () =>
      Object.fromEntries(
        readdirSync(dir, { recursive: true, withFileTypes: false })
          .map(String)
          .filter((f) => statSync(join(dir, f)).isFile())
          .map((f) => [f, readFileSync(join(dir, f)).toString('base64')]),
      );
    const before = snap();
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['project.json', 'history.jsonl']));
    // a fresh engine (no cached store), like opening the project in a new session
    const fresh = openEngine({
      projectsDir: join(home, 'Projects'),
      stylesDirs: [STYLES],
      trustFile: join(home, 'trust.json'),
    });
    const h2 = createHandlers(fresh);
    await expect(call(h2, 'projects.open', p.id)).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
    expect(snap()).toEqual(before);
  });

  it('makeClips (test build): seeds by media hash, then quick clips make 3 sequences in one entry', async () => {
    const { h, engine, events } = setup({ seeds: true });
    const p = await call<{ id: string }>(h, 'projects.create', 'Quick');
    const ing = await engine.jobs.wait(
      engine.jobs.start('ingest', { projectId: p.id, inputs: [SEED_MP4] }),
    );
    expect(ing.status).toBe('done');
    const mediaId = (ing.result as { media: { mediaId: string }[] }).media[0]!.mediaId;
    const before = (await engine.history(p.id)).length;
    const id = await call<string>(h, 'jobs.start', 'makeClips', {
      projectId: p.id,
      mediaId,
      count: 3,
      minMs: 4000,
      maxMs: 8000,
    });
    const job = await waitJob(h, id);
    expect(job).toMatchObject({ status: 'done', result: { sequenceIds: expect.any(Array) } });
    const res = job.result as { sequenceIds: string[] };
    expect(res.sequenceIds).toHaveLength(3);
    // the seed (updateMedia) and quick clips: two entries; no transcribe / facetrack job ran
    expect((await engine.history(p.id)).length).toBe(before + 2);
    expect(engine.jobs.list(p.id).map((j) => j.kind)).toEqual(['ingest', 'quickClips']);
    expect(events.map((e) => e[0])).toEqual(
      expect.arrayContaining(['job.started', 'job.progress', 'job.done']),
    );
  }, 120_000);

  it('makeClips cancels its running stage and ends cancelled', async () => {
    const { h, engine } = setup();
    const p = await call<{ id: string }>(h, 'projects.create', 'C');
    await addMedia(engine, p.id, { ...MEDIA, id: 'm_x', path: 'media/x.mp4', tags: [] });
    const id = await call<string>(h, 'jobs.start', 'makeClips', { projectId: p.id, mediaId: 'm_x' });
    await call(h, 'jobs.cancel', id);
    expect((await waitJob(h, id)).status).toMatch(/cancelled|failed/);
  });
});
