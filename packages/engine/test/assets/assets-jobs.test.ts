// Asset jobs on the engine (phase 05 steps 1–4, S7, S29): search through the job runner with the
// config contact, fetch over checked HTTPS into one `addMedia` with the licence and attribution,
// cutout refusals (ND licence, not an image), image providers (none → PROVIDER_MISSING with a hint,
// a fake provider → a generated image with its prompt, one history entry with the jobId).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { openEngine, version, type Engine } from '../../src/api.ts';
import { VoxError } from '../../src/errors.ts';
import type { JobInfo } from '../../src/jobs.ts';
import type { Resolver } from '../../src/net/address.ts';
import type { GetJson } from '../../src/stages/assets.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';
import {
  PUBLIC_HOST,
  PUBLIC_IP,
  httpsServer,
  makeCert,
  type Cert,
  type TestServer,
} from '../net/servers.ts';

const FACE = new URL('../fixtures/assets/faces/face-a.jpg', import.meta.url).pathname;
const TAP = new URL('../fixtures/assets/sfx/tap.wav', import.meta.url).pathname;
const CARD = new URL('../fixtures/assets/captions/card-1.png', import.meta.url).pathname;
const fakePy = new URL('../helpers/fake-py.mjs', import.meta.url).pathname;

let cert: Cert;
let srv: TestServer;
const hits: string[] = [];
beforeAll(async () => {
  cert = makeCert();
  const jpg = readFileSync(FACE);
  srv = await httpsServer(cert, (req, res) => {
    hits.push(`${req.url} ${req.headers['user-agent']}`);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpg.length });
    res.end(jpg);
  });
});
afterAll(async () => srv.close());

const resolver: Resolver = async (host) => {
  if (host === PUBLIC_HOST) return [PUBLIC_IP];
  throw new VoxError('NET_DNS', `no ${host}`, 'x');
};
const dial = (addr: string, port: number) =>
  addr === PUBLIC_IP ? { host: '127.0.0.1', port: srv.port } : { host: addr, port };

/** One Openverse reply: a CC BY image on the fake public host, and an ND one (dropped). */
const reply = {
  results: [
    {
      id: 'aaaa-1111',
      title: 'Tram <b>28</b>',
      url: `https://${PUBLIC_HOST}/tram.jpg`,
      foreign_landing_url: `https://${PUBLIC_HOST}/page`,
      creator: 'Ana',
      license: 'by',
      license_version: '4.0',
      license_url: 'https://creativecommons.org/licenses/by/4.0/',
    },
    {
      id: 'bbbb-2222',
      title: 'No derivatives',
      url: `https://${PUBLIC_HOST}/nd.jpg`,
      creator: 'Bo',
      license: 'by-nd',
    },
  ],
};

function engine(
  config: Record<string, unknown> = {},
  calls: string[] = [],
  stylesDirs: string[] = [],
): Engine {
  const getJson: GetJson = async (url, headers) => {
    calls.push(`${new URL(url).host} ${headers['user-agent']}`);
    return new URL(url).host === 'api.openverse.org' ? reply : { batchcomplete: true };
  };
  return openEngine({
    projectsDir: join(tempDir('vox-assets-jobs-'), 'Projects'),
    stylesDirs,
    templates,
    config: async () => config,
    net: { resolver, dial },
    assets: { getJson, ca: cert.cert, sleep: async () => {}, commonsThrottle: async () => {} },
  });
}

async function run<R>(e: Engine, kind: string, args: unknown): Promise<JobInfo<R>> {
  return (await e.jobs.wait(e.jobs.start(kind, args))) as JobInfo<R>;
}

async function addFile(
  e: Engine,
  projectId: string,
  id: string,
  kind: 'image' | 'audio',
  license?: string,
): Promise<void> {
  const dir = join(e.projectsDir, projectId, 'media');
  await mkdir(dir, { recursive: true });
  const ext = kind === 'image' ? 'jpg' : 'wav';
  await copyFile(kind === 'image' ? FACE : TAP, join(dir, `${id}.${ext}`));
  await e.applyOp(
    projectId,
    {
      op: 'addMedia',
      args: {
        media: {
          id,
          kind,
          path: `media/${id}.${ext}`,
          ...(kind === 'image' ? { width: 64, height: 64 } : { durationMs: 200, hasAudio: true }),
          origin: { type: 'upload', ...(license ? { license } : {}) },
          tags: [],
        },
      },
    },
    { actor: 'user' },
  );
}

describe('asset job kinds', () => {
  test('the engine runs the four asset jobs', () => {
    expect(engine().jobs.kinds()).toEqual(
      expect.arrayContaining(['assets.search', 'assets.fetch', 'assets.cutout', 'assets.generate']),
    );
  });
});

describe('assets.search + assets.fetch', () => {
  test('search uses the config contact; fetch adds the image with licence and attribution', async () => {
    const calls: string[] = [];
    const e = engine({ contact: 'https://example.org/contact' }, calls);
    const p = await e.createProject('assets');
    const s = await run<{ candidates: { id: string; license: string }[]; dropped: number }>(
      e,
      'assets.search',
      { projectId: p.id, query: 'tram', sources: ['openverse'] },
    );
    expect(s.status).toBe('done');
    expect(s.result?.candidates.map((c) => [c.id, c.license])).toEqual([
      ['openverse-aaaa-1111', 'CC BY'],
    ]);
    expect(s.result?.dropped).toBe(1);
    expect(calls).toEqual([`api.openverse.org VoxStudio/${version} (https://example.org/contact)`]);

    const f = await run<{ mediaId: string; reused: boolean; license: string; version: number }>(
      e,
      'assets.fetch',
      { projectId: p.id, candidateId: 'openverse-aaaa-1111', actor: 'cli' },
    );
    expect(f.status, JSON.stringify(f.error)).toBe('done');
    expect(f.result?.license).toBe('CC BY 4.0');
    expect(hits.at(-1)).toBe(`/tram.jpg VoxStudio/${version} (https://example.org/contact)`);
    const proj = await e.getProject(p.id);
    const m = proj.media.find((x) => x.id === f.result?.mediaId);
    expect(m?.kind).toBe('image');
    expect(m?.origin).toMatchObject({
      type: 'archive',
      url: `https://${PUBLIC_HOST}/page`,
      license: 'CC BY 4.0',
      author: 'Ana',
    });
    expect(m?.origin.attribution).toContain('Ana');
    const h = await e.history(p.id);
    expect(h.filter((x) => x.jobId === f.id)).toHaveLength(1);

    // Same bytes again: the earlier item, no new history entry.
    const again = await run<{ mediaId: string; reused: boolean }>(e, 'assets.fetch', {
      projectId: p.id,
      candidateId: 'openverse-aaaa-1111',
    });
    expect(again.result).toMatchObject({ mediaId: f.result?.mediaId, reused: true });
    expect(await e.history(p.id)).toHaveLength(h.length);
  });

  test('a candidate that was never listed is NOT_FOUND', async () => {
    const e = engine();
    const p = await e.createProject('assets');
    const f = await run(e, 'assets.fetch', { projectId: p.id, candidateId: 'openverse-zzzz' });
    expect(f.status).toBe('failed');
    expect(f.error?.code).toBe('NOT_FOUND');
  });
});

describe('assets.cutout refusals', () => {
  test('an ND image is refused with LICENSE_REFUSED before any model work', async () => {
    const e = engine();
    const p = await e.createProject('cut');
    await addFile(e, p.id, 'm_nd1', 'image', 'CC BY-ND 4.0');
    const r = await run(e, 'assets.cutout', { projectId: p.id, mediaId: 'm_nd1' });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('LICENSE_REFUSED');
    expect(r.error?.hint).toMatch(/CC0, PDM, CC BY or CC BY-SA/);
  });

  test('audio is not an image: MEDIA_UNSUPPORTED', async () => {
    const e = engine();
    const p = await e.createProject('cut');
    await addFile(e, p.id, 'm_aud1', 'audio');
    const r = await run(e, 'assets.cutout', { projectId: p.id, mediaId: 'm_aud1' });
    expect(r.error?.code).toBe('MEDIA_UNSUPPORTED');
  });
});

describe('assets.cutout fetches u2net only for the fallback (D-72)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** An engine with the fake Python tool and a stand-in u2net served by the local HTTPS server. */
  function cutEngine() {
    const toolsDir = tempDir('vox-cut-tools-');
    const models = join(toolsDir, 'models');
    const log = join(toolsDir, 'py.log');
    vi.stubEnv('VOX_FAKE_PY_LOG', log);
    vi.stubEnv('VOX_FAKE_CUTOUT_PNG', CARD);
    const e = openEngine({
      projectsDir: join(tempDir('vox-cut-'), 'Projects'),
      stylesDirs: [],
      templates,
      tools: { uv: fakePy, py: '/nonexistent-py-project', models },
      config: async () => ({}),
      net: { resolver, dial },
      assets: {
        ca: cert.cert,
        sleep: async () => {},
        cutoutModel: {
          name: 'u2net.onnx',
          url: `https://${PUBLIC_HOST}/u2net.onnx`,
          sha256: createHash('sha256').update(readFileSync(FACE)).digest('hex'),
          maxBytes: 1024 * 1024,
          label: 'cutout model',
        },
      },
    });
    const model = join(models, 'rembg', 'u2net.onnx');
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l.startsWith('cutout model='))
        : [];
    return { e, model, calls };
  }

  const fetched = () => hits.filter((h) => h.startsWith('/u2net.onnx')).length;

  test('Vision finds the subject: no model, no download, one tool run', async () => {
    const { e, model, calls } = cutEngine();
    const p = await e.createProject('cut');
    await addFile(e, p.id, 'm_img1', 'image');
    const before = fetched();
    const r = await run<{ mediaId: string }>(e, 'assets.cutout', {
      projectId: p.id,
      mediaId: 'm_img1',
    });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    expect(calls()).toEqual(['cutout model=-']);
    expect(fetched()).toBe(before);
    expect(existsSync(model)).toBe(false);
    const m = (await e.getProject(p.id)).media.find((x) => x.id === r.result!.mediaId)!;
    expect(m.tags).toContain('cutout');
  });

  test('no subject: fetches the model once, then reruns the tool with it', async () => {
    const { e, model, calls } = cutEngine();
    vi.stubEnv('VOX_FAKE_CUTOUT_NO_SUBJECT', '1');
    const p = await e.createProject('cut');
    await addFile(e, p.id, 'm_img1', 'image');
    const before = fetched();
    const r = await run(e, 'assets.cutout', { projectId: p.id, mediaId: 'm_img1' });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    expect(calls()).toEqual(['cutout model=-', `cutout model=${model}`]);
    expect(fetched()).toBe(before + 1);
    expect(existsSync(model)).toBe(true);
  });

  test('the model is still missing after the fetch: the job fails after one retry', async () => {
    const { e, model, calls } = cutEngine();
    vi.stubEnv('VOX_FAKE_CUTOUT_ERROR', 'MODEL_MISSING');
    const p = await e.createProject('cut');
    await addFile(e, p.id, 'm_img1', 'image');
    const r = await run(e, 'assets.cutout', { projectId: p.id, mediaId: 'm_img1' });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('PY_TOOL_FAILED');
    expect(calls()).toEqual(['cutout model=-', `cutout model=${model}`]);
  });

  test('any other tool error fails at once, with no download', async () => {
    const { e, model, calls } = cutEngine();
    vi.stubEnv('VOX_FAKE_CUTOUT_ERROR', 'MEDIA_UNREADABLE');
    const p = await e.createProject('cut');
    await addFile(e, p.id, 'm_img1', 'image');
    const before = fetched();
    const r = await run(e, 'assets.cutout', { projectId: p.id, mediaId: 'm_img1' });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('PY_TOOL_FAILED');
    expect(r.error?.message).toMatch(/MEDIA_UNREADABLE/);
    expect(calls()).toEqual(['cutout model=-']);
    expect(fetched()).toBe(before);
    expect(existsSync(model)).toBe(false);
  });
});

describe('image providers', () => {
  test('none registered: PROVIDER_MISSING with a hint, nothing added', async () => {
    const e = engine();
    const p = await e.createProject('gen');
    const r = await run(e, 'assets.generate', { projectId: p.id, prompt: 'a red tram' });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('PROVIDER_MISSING');
    expect(r.error?.hint).toMatch(/vox assets search/);
    expect((await e.getProject(p.id)).media).toEqual([]);
  });

  test('a fake provider makes a generated image with its prompt; unknown id is NOT_FOUND', async () => {
    const e = engine();
    const seen: unknown[] = [];
    const out = tempDir('vox-gen-out-');
    e.imageProviders.register({
      id: 'fake-gen',
      async generate(req) {
        seen.push(req);
        const f = join(out, 'gen.jpg');
        await copyFile(FACE, f);
        return f;
      },
    });
    expect(e.imageProviders.list()).toEqual([{ id: 'fake-gen' }]);
    expect(() => e.imageProviders.register({ id: 'fake-gen', generate: async () => '' })).toThrow(
      /already registered/,
    );
    expect(() => e.imageProviders.register({ id: 'Bad Id', generate: async () => '' })).toThrow(
      VoxError,
    );
    const p = await e.createProject('gen');
    const r = await run<{ mediaId: string; provider: string }>(e, 'assets.generate', {
      projectId: p.id,
      prompt: 'a red tram',
      width: 512,
      height: 512,
      seed: 7,
      actor: 'agent',
    });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    expect(seen).toEqual([{ prompt: 'a red tram', width: 512, height: 512, seed: 7 }]);
    const m = (await e.getProject(p.id)).media.find((x) => x.id === r.result?.mediaId);
    expect(m?.origin).toEqual({ type: 'generated', prompt: 'a red tram', author: 'fake-gen' });
    expect((await e.history(p.id)).filter((x) => x.jobId === r.id)).toHaveLength(1);
    const bad = await run(e, 'assets.generate', { projectId: p.id, prompt: 'x', provider: 'nope' });
    expect(bad.error?.code).toBe('NOT_FOUND');
  });

  test("a prompt that names a style ends with the style's look (D-101)", async () => {
    const styles = new URL('../../../../styles', import.meta.url).pathname;
    const e = engine({}, [], [styles]);
    const seen: string[] = [];
    const out = tempDir('vox-gen-style-');
    e.imageProviders.register({
      id: 'fake-gen',
      async generate(req) {
        seen.push(req.prompt);
        const f = join(out, `gen-${String(seen.length)}.jpg`);
        await copyFile(FACE, f);
        return f;
      },
    });
    const p = await e.createProject('gen');
    const vox = e.styles.get('vox').style.imagery.generateSuffix;
    expect(vox).toMatch(/^Torn paper collage/);
    const r = await run<{ mediaId: string }>(e, 'assets.generate', {
      projectId: p.id,
      prompt: 'a market stall.',
      styleId: 'vox',
    });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    await run(e, 'assets.generate', { projectId: p.id, prompt: 'a tram', styleId: 'nope' });
    expect(seen).toEqual([`a market stall. ${vox}`, 'a tram']);
    const m = (await e.getProject(p.id)).media.find((x) => x.id === r.result?.mediaId);
    expect(m?.origin).toMatchObject({ prompt: `a market stall. ${vox}` });
  });

  test('a provider that returns a relative path fails TOOL_FAILED', async () => {
    const e = engine();
    e.imageProviders.register({ id: 'rel', generate: async () => 'gen.jpg' });
    const p = await e.createProject('gen');
    await writeFile(join(e.projectsDir, p.id, 'x'), '');
    const r = await run(e, 'assets.generate', { projectId: p.id, prompt: 'x' });
    expect(r.error?.code).toBe('TOOL_FAILED');
  });
});
