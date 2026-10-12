// Local image generation with a fake mflux (phase 14d): the `mflux` provider is registered once a
// models folder exists but is hidden until its model is installed; `imagegen.install` runs the
// Python tool, then deletes the download cache; `assets.generate` uses the installed model; remove
// deletes it again. A fake `uv` stands in for the Python tool (no model, no network).
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { imagegenStatus, openEngine, type Engine } from '../../src/api.ts';
import { hfTokenPresent, isInstalled, modelDir } from '../../src/imagegen.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';

const FAKE_UV = new URL('./fake-uv-imagegen.mjs', import.meta.url).pathname;
const FACE = new URL('../fixtures/assets/faces/face-a.jpg', import.meta.url).pathname;

let tools: string;
let log: string;
beforeEach(() => {
  tools = tempDir('vox-imagegen-tools-');
  log = join(tempDir('vox-imagegen-log-'), 'uv.json');
  process.env['VOX_FAKE_UV_LOG'] = log;
  process.env['VOX_FAKE_IMAGE'] = FACE;
  for (const k of [
    'VOX_FAKE_FAIL',
    'VOX_FAKE_FAIL_AFTER_DOWNLOAD',
    'VOX_FAKE_HANG_AFTER_DOWNLOAD',
    'VOX_FAKE_CRASH',
  ]) {
    delete process.env[k];
  }
});

function engine(
  models: string | null = join(tools, 'models'),
  imagegen?: NonNullable<Parameters<typeof openEngine>[0]['imagegen']>,
  extraTools: Record<string, string> = {},
): Engine {
  return openEngine({
    projectsDir: join(tempDir('vox-imagegen-'), 'Projects'),
    stylesDirs: [],
    templates,
    config: async () => ({}),
    tools: { ...(models ? { models } : {}), uv: FAKE_UV, py: tools, ...extraTools },
    ...(imagegen ? { imagegen } : {}),
  });
}

async function run<R>(e: Engine, kind: string, args: unknown): Promise<JobInfo<R>> {
  return (await e.jobs.wait(e.jobs.start(kind, args))) as JobInfo<R>;
}

describe('mflux provider (fake tool)', () => {
  test('no models folder: no mflux jobs or providers (existing behaviour)', () => {
    const e = engine(null);
    expect(e.imageProviders.list()).toEqual([]);
    expect(e.jobs.kinds()).not.toContain('imagegen.install');
  });

  test('not installed: the provider is hidden and generating says how to install', async () => {
    const e = engine();
    expect(e.imageProviders.list()).toEqual([]);
    expect(e.jobs.kinds()).toEqual(expect.arrayContaining(['imagegen.install', 'imagegen.remove']));
    const p = await e.createProject('gen');
    const r = await run(e, 'assets.generate', { projectId: p.id, prompt: 'a red tram' });
    expect(r.error?.code).toBe('PROVIDER_MISSING');
    expect(r.error?.hint).toMatch(/vox imagegen install/);
    const named = await run(e, 'assets.generate', {
      projectId: p.id,
      prompt: 'x',
      provider: 'mflux',
    });
    expect(named.error?.code).toBe('PROVIDER_MISSING');
  });

  test('install → provider appears → generate adds a generated image → remove', async () => {
    const e = engine(undefined, { freeBytes: () => 1e12 });
    const models = join(tools, 'models');
    const inst = await run<{ providerId: string; bytes: number }>(e, 'imagegen.install', {});
    expect(inst.status, JSON.stringify(inst.error)).toBe('done');
    expect(inst.result).toMatchObject({ providerId: 'mflux', bytes: 2048 });
    expect(isInstalled(models, 'z-image-turbo')).toBe(true);
    // the big download cache is gone, the model folder stays
    expect(existsSync(join(models, 'mflux', '.download-z-image-turbo'))).toBe(false);
    const sent = JSON.parse(readFileSync(log, 'utf8')) as { req: Record<string, unknown> };
    expect(sent.req).toMatchObject({ action: 'install', model: 'z-image-turbo' });
    expect(e.imageProviders.list()).toEqual([{ id: 'mflux' }]);

    const p = await e.createProject('gen');
    const r = await run<{ mediaId: string; provider: string }>(e, 'assets.generate', {
      projectId: p.id,
      prompt: 'a paper tram',
      width: 576,
      height: 1024,
      seed: 5,
    });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    expect(r.result?.provider).toBe('mflux');
    const gen = JSON.parse(readFileSync(log, 'utf8')) as { req: Record<string, unknown> };
    expect(gen.req).toMatchObject({
      action: 'generate',
      model: 'z-image-turbo',
      modelDir: modelDir(models, 'z-image-turbo'),
      prompt: 'a paper tram',
      width: 576,
      height: 1024,
      seed: 5,
    });
    // the provider's temporary file is deleted after the copy
    expect(existsSync(String(gen.req['output']))).toBe(false);
    const m = (await e.getProject(p.id)).media.find((x) => x.id === r.result?.mediaId);
    expect(m?.origin).toEqual({ type: 'generated', prompt: 'a paper tram', author: 'mflux' });

    const st = await imagegenStatus(models, {});
    expect(st.find((s) => s.id === 'z-image-turbo')).toMatchObject({
      installed: true,
      license: 'Apache-2.0',
    });
    expect(st.find((s) => s.id === 'z-image-turbo')!.sizeOnDisk).toBeGreaterThan(2000);

    const rm = await run<{ removed: boolean }>(e, 'imagegen.remove', {});
    expect(rm.result).toEqual({ removed: true });
    expect(e.imageProviders.list()).toEqual([]);
  });

  test('a later API provider stays the default over mflux; mflux wins when alone', async () => {
    const e = engine(undefined, { freeBytes: () => 1e12 });
    await run(e, 'imagegen.install', {});
    e.imageProviders.register({ id: 'api-gen', generate: async () => FACE });
    expect(e.imageProviders.list().map((x) => x.id)).toEqual(['mflux', 'api-gen']);
  });

  test('not enough disk space fails before downloading anything', async () => {
    const e = engine(undefined, { freeBytes: () => 5e9 });
    const r = await run(e, 'imagegen.install', {});
    expect(r.status).toBe('failed');
    expect(r.error?.message).toMatch(/Not enough free disk space/);
    expect(existsSync(log)).toBe(false);
  });

  test('FLUX.1-schnell needs a token: refused without one, never asked for', async () => {
    const home = tempDir('vox-imagegen-home-');
    const e = engine(undefined, { freeBytes: () => 1e12, env: { HF_HOME: home } });
    const r = await run(e, 'imagegen.install', { model: 'flux1-schnell' });
    expect(r.error?.code).toBe('PROVIDER_MISSING');
    expect(r.error?.hint).toMatch(/HF_TOKEN/);
    expect(existsSync(log)).toBe(false);
    expect(hfTokenPresent({ HF_HOME: home })).toBe(false);
    expect(hfTokenPresent({ HF_TOKEN: 'x' })).toBe(true);
    // with a token the install runs (the fake tool stands in for Hugging Face)
    const e2 = engine(undefined, {
      freeBytes: () => 1e12,
      env: { HF_TOKEN: 'canary-not-a-real-token' },
    });
    const ok = await run<{ providerId: string }>(e2, 'imagegen.install', {
      model: 'flux1-schnell',
    });
    expect(ok.result?.providerId).toBe('mflux-flux1-schnell');
    expect(e2.imageProviders.list()).toEqual([{ id: 'mflux-flux1-schnell' }]);
  });

  test('a tool failure keeps the model uninstalled and cleans the half-written model', async () => {
    process.env['VOX_FAKE_FAIL'] = 'MODEL_GATED';
    const e = engine(undefined, { freeBytes: () => 1e12 });
    const r = await run(e, 'imagegen.install', {});
    expect(r.status).toBe('failed');
    expect(r.error?.hint).toMatch(/Hugging Face/);
    expect(isInstalled(join(tools, 'models'), 'z-image-turbo')).toBe(false);
    await mkdir(join(tools, 'models'), { recursive: true });
  });
});

// D-69: a failed or cancelled install keeps the download cache, so the next try resumes
// (huggingface_hub continues its `.incomplete` files) instead of fetching 33 GB again. Only a
// successful install or `imagegen.remove` deletes it; status reports its size so it is never hidden.
describe('mflux install: the partial download is kept for resume (D-69)', () => {
  const models = () => join(tools, 'models');
  const cache = () => join(models(), 'mflux', '.download-z-image-turbo');
  const part = () => `${modelDir(models(), 'z-image-turbo')}.part`;

  test('a failed install keeps the partial download, drops the .part folder, and status shows it', async () => {
    process.env['VOX_FAKE_FAIL_AFTER_DOWNLOAD'] = 'NETWORK';
    const e = engine(undefined, { freeBytes: () => 1e12 });
    const r = await run(e, 'imagegen.install', {});
    expect(r.status).toBe('failed');
    expect(r.error?.message).toMatch(/connection reset/);
    expect(existsSync(join(cache(), 'snapshot.bin.incomplete'))).toBe(true);
    expect(existsSync(part())).toBe(false);
    expect(isInstalled(models(), 'z-image-turbo')).toBe(false);
    const st = await imagegenStatus(models(), {});
    expect(st[0]).toMatchObject({ id: 'z-image-turbo', installed: false });
    expect(st[0]!.partialBytes).toBeGreaterThanOrEqual(4096);
    expect(st[1]!.partialBytes).toBe(0);
  });

  test('the next install resumes from the kept download and deletes it once installed', async () => {
    process.env['VOX_FAKE_FAIL_AFTER_DOWNLOAD'] = 'NETWORK';
    const e = engine(undefined, { freeBytes: () => 1e12 });
    await run(e, 'imagegen.install', {});
    delete process.env['VOX_FAKE_FAIL_AFTER_DOWNLOAD'];
    const ok = await run(e, 'imagegen.install', {});
    expect(ok.status, JSON.stringify(ok.error)).toBe('done');
    const sent = JSON.parse(readFileSync(log, 'utf8')) as { resumed: boolean };
    expect(sent.resumed).toBe(true);
    expect(existsSync(cache())).toBe(false);
    const st = await imagegenStatus(models(), {});
    expect(st[0]).toMatchObject({ installed: true, partialBytes: 0 });
  });

  test('a cancelled install keeps the partial download too', async () => {
    process.env['VOX_FAKE_HANG_AFTER_DOWNLOAD'] = '1';
    const e = engine(undefined, { freeBytes: () => 1e12 });
    const id = e.jobs.start('imagegen.install', {});
    for (let i = 0; i < 400 && !existsSync(join(cache(), 'snapshot.bin.incomplete')); i++) {
      await new Promise((res) => setTimeout(res, 25));
    }
    e.jobs.cancel(id);
    const r = await e.jobs.wait(id);
    expect(r.status).toBe('cancelled');
    expect(existsSync(join(cache(), 'snapshot.bin.incomplete'))).toBe(true);
    expect(existsSync(part())).toBe(false);
  });

  test('remove deletes the partial download as well and reports the bytes it freed', async () => {
    process.env['VOX_FAKE_FAIL_AFTER_DOWNLOAD'] = 'NETWORK';
    const e = engine(undefined, { freeBytes: () => 1e12 });
    await run(e, 'imagegen.install', {});
    const rm = await run<{ removed: boolean; partialBytes?: number }>(e, 'imagegen.remove', {});
    expect(rm.result?.removed).toBe(false);
    expect(rm.result?.partialBytes).toBeGreaterThanOrEqual(4096);
    expect(existsSync(cache())).toBe(false);
    expect((await imagegenStatus(models(), {}))[0]!.partialBytes).toBe(0);
  });

  test('the free-space check counts what the partial download already holds', async () => {
    // download 32.8 GB + kept 10 GB = 42.8 GB: 13 GB free is not enough from scratch
    const e = engine(undefined, { freeBytes: () => 13e9 });
    const none = await run(e, 'imagegen.install', {});
    expect(none.error?.message).toMatch(/Not enough free disk space/);
    // a sparse 30 GB stand-in for the partial download: its size counts, the disk does not fill
    mkdirSync(cache(), { recursive: true });
    const fd = openSync(join(cache(), 'snapshot.bin.incomplete'), 'w');
    ftruncateSync(fd, 30e9);
    closeSync(fd);
    const r = await run(e, 'imagegen.install', {});
    expect(r.status, JSON.stringify(r.error)).toBe('done');
  });
});

// The packaged tools env (D-12) must come from this build's uv.lock: an env synced from another
// lock lacks modules (e.g. `mflux`) and used to fail in a second with a bare "exit code 1".
describe('mflux: the Python env is checked first (D-69)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  function packaged(lockHash: string | null): Record<string, string> {
    const dir = tempDir('vox-imagegen-apptools-');
    const pyEnv = join(dir, 'py-env');
    mkdirSync(pyEnv, { recursive: true });
    writeFileSync(join(tools, 'uv.lock'), 'lock v2\n');
    if (lockHash !== null) writeFileSync(join(pyEnv, '.vox-lock-hash'), lockHash);
    return { pyEnv, dir };
  }

  test('an env synced from a different uv.lock refuses install and generate with the fix', async () => {
    const e = engine(undefined, { freeBytes: () => 1e12 }, packaged(sha('lock v1\n')));
    const r = await run(e, 'imagegen.install', {});
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('TOOL_MISSING');
    expect(r.error?.message).toMatch(/different uv\.lock/);
    expect(r.error?.hint).toMatch(/open Vox Studio/);
    expect(r.error?.hint).toMatch(/Setup → Repair/);
    expect(r.error?.details).toMatchObject({ check: 'python-env-lock', state: 'stale' });
    expect(existsSync(log)).toBe(false);

    // an installed model with a stale env: generate says the same, before running anything
    const dir = modelDir(join(tools, 'models'), 'z-image-turbo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'vox-model.json'), '{}');
    const p = await e.createProject('gen');
    const g = await run(e, 'assets.generate', { projectId: p.id, prompt: 'a tram' });
    expect(g.error?.code).toBe('TOOL_MISSING');
    expect(g.error?.message).toMatch(/different uv\.lock/);
    expect(existsSync(log)).toBe(false);
  });

  test('an env with no lock hash (never synced by setup) is refused too', async () => {
    const e = engine(undefined, { freeBytes: () => 1e12 }, packaged(null));
    const r = await run(e, 'imagegen.install', {});
    expect(r.error?.code).toBe('TOOL_MISSING');
    expect(r.error?.details).toMatchObject({ state: 'unsynced' });
    expect(r.error?.hint).toMatch(/open Vox Studio/);
  });

  test('an env synced from this uv.lock installs as before', async () => {
    const e = engine(undefined, { freeBytes: () => 1e12 }, packaged(sha('lock v2\n')));
    const r = await run(e, 'imagegen.install', {});
    expect(r.status, JSON.stringify(r.error)).toBe('done');
  });

  test('a tool that dies before its error line shows the Python exception, not only the exit code', async () => {
    process.env['VOX_FAKE_CRASH'] = '1';
    const e = engine(undefined, { freeBytes: () => 1e12 });
    const r = await run(e, 'imagegen.install', {});
    expect(r.error?.code).toBe('PY_TOOL_FAILED');
    expect(r.error?.message).toMatch(/ModuleNotFoundError: No module named 'mflux'/);
    expect(r.error?.details).toMatchObject({
      stderr: "ModuleNotFoundError: No module named 'mflux'",
    });
    expect(r.error?.hint).toMatch(/Python env/);
  });
});
