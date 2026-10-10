import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configPath, readConfig, writeConfig } from '../../src/config.ts';
import { isVoxError } from '../../src/errors.pending.ts';

let home: string;
let scratch: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

beforeEach(async () => {
  // R3: tests never touch the owner's data.
  home = await tmp('vox-home-');
  vi.stubEnv('VOX_HOME', home);
  vi.stubEnv('VOX_PROJECTS_DIR', await tmp('vox-projects-'));
  vi.stubEnv('VOX_TOOLS_DIR', await tmp('vox-tools-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
  scratch = [];
});

describe('config location', () => {
  it('lives at $VOX_HOME/config.json', () => {
    expect(configPath()).toBe(join(home, 'config.json'));
  });
});

describe('readConfig', () => {
  it('returns an empty config when the file does not exist and creates nothing', async () => {
    expect(await readConfig()).toEqual({});
    expect(await readdir(home)).toEqual([]);
  });

  it('fails with CONFIG_INVALID on broken JSON', async () => {
    await writeFile(configPath(), '{ not json');
    const err = await readConfig().catch((e: unknown) => e);
    expect(isVoxError(err) && err.code).toBe('CONFIG_INVALID');
  });

  it('fails with CONFIG_INVALID when a known key has the wrong type', async () => {
    await writeFile(configPath(), JSON.stringify({ ingest: { cookiesFromBrowser: 'netscape' } }));
    const err = await readConfig().catch((e: unknown) => e);
    expect(isVoxError(err) && err.code).toBe('CONFIG_INVALID');
  });

  it('keeps keys it does not know (another writer owns them)', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ futureSection: { a: 1 }, contact: 'me@x.test' }),
    );
    expect(await readConfig()).toEqual({ futureSection: { a: 1 }, contact: 'me@x.test' });
  });
});

describe('writeConfig (S17)', () => {
  it('first write creates config.json with mode 0600 (and VOX_HOME with 0700)', async () => {
    await rm(home, { recursive: true });
    await writeConfig({ contact: 'me@example.test' });
    expect((await stat(configPath())).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
      contact: 'me@example.test',
    });
  });

  it('rewrites a pre-existing looser file as 0600', async () => {
    await writeFile(configPath(), '{}', { mode: 0o644 });
    await writeConfig({ contact: 'me@example.test' });
    expect((await stat(configPath())).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp or lock files behind', async () => {
    await writeConfig({ contact: 'a@b.test' });
    expect(await readdir(home)).toEqual(['config.json']);
  });

  it('merges the patch and keeps keys it does not name', async () => {
    await writeConfig({ contact: 'me@example.test', projectsDir: '/tmp/vox-projects' });
    await writeConfig({ ingest: { cookiesFromBrowser: 'safari' } });
    await writeConfig({
      providers: [{ id: 'openrouter', type: 'openrouter', apiKey: 'keychain:openrouter' }],
      limits: { maxUsdPerRun: 2 },
    });
    const after = await writeConfig({ limits: { maxStepsPerRun: 60 } });
    expect(after).toEqual({
      contact: 'me@example.test',
      projectsDir: '/tmp/vox-projects',
      ingest: { cookiesFromBrowser: 'safari' },
      providers: [{ id: 'openrouter', type: 'openrouter', apiKey: 'keychain:openrouter' }],
      limits: { maxUsdPerRun: 2, maxStepsPerRun: 60 },
    });
    expect(await readConfig()).toEqual(after);
  });

  it('null in a patch removes that key (JSON merge patch); arrays are replaced', async () => {
    await writeConfig({
      contact: 'me@example.test',
      ingest: { cookiesFromBrowser: 'chrome' },
      providers: [
        { id: 'a', type: 'openai' },
        { id: 'b', type: 'ollama' },
      ],
    });
    const after = await writeConfig({
      ingest: { cookiesFromBrowser: null },
      providers: [{ id: 'b', type: 'ollama' }],
    });
    expect(after).toEqual({
      contact: 'me@example.test',
      ingest: {},
      providers: [{ id: 'b', type: 'ollama' }],
    });
  });

  it('keeps unknown keys written by someone else', async () => {
    await writeFile(configPath(), JSON.stringify({ futureSection: { a: 1 } }));
    expect(await writeConfig({ contact: 'x@y.test' })).toEqual({
      futureSection: { a: 1 },
      contact: 'x@y.test',
    });
  });

  it('rejects an invalid result with CONFIG_INVALID and leaves the file unchanged', async () => {
    await writeConfig({ contact: 'me@example.test' });
    const before = await readFile(configPath(), 'utf8');
    for (const bad of [
      { projectsDir: 'relative/path' },
      { ingest: { cookiesFromBrowser: 'netscape' } },
      { limits: { maxStepsPerRun: -1 } },
    ]) {
      const err = await writeConfig(bad as never).catch((e: unknown) => e);
      expect(isVoxError(err) && err.code).toBe('CONFIG_INVALID');
    }
    expect(await readFile(configPath(), 'utf8')).toBe(before);
    expect(await readdir(home)).toEqual(['config.json']);
  });

  it('ignores __proto__ keys in a patch', async () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "contact": "a@b.test"}');
    const out = await writeConfig(patch);
    expect(out).toEqual({ contact: 'a@b.test' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('concurrent in-process writes do not lose a key', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    await Promise.all(keys.map((k) => writeConfig({ [k]: k })));
    const cfg = await readConfig();
    for (const k of keys) expect(cfg[k]).toBe(k);
  });

  it('concurrent writes from separate processes do not lose a key', async () => {
    const worker = fileURLToPath(new URL('./write-worker.ts', import.meta.url));
    const n = 6;
    const perProc = 5;
    await Promise.all(
      Array.from(
        { length: n },
        (_, p) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [worker, `p${p}`, String(perProc)], {
              env: { ...process.env, VOX_HOME: home },
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let err = '';
            child.stderr.on('data', (d: Buffer) => (err += d.toString()));
            child.on('close', (code) =>
              code === 0 ? resolve() : reject(new Error(`worker ${p} exit ${code}: ${err}`)),
            );
          }),
      ),
    );
    const cfg = await readConfig();
    for (let p = 0; p < n; p++) for (let i = 0; i < perProc; i++) expect(cfg[`p${p}_${i}`]).toBe(i);
    expect(await readdir(home)).toEqual(['config.json']);
  }, 30_000);

  it('a stale lock left by a dead process does not block writers', async () => {
    await mkdir(home, { recursive: true });
    // pid 2^22-ish that is not running on this host
    await writeFile(
      join(home, 'config.json.lock'),
      JSON.stringify({
        pid: 4_000_000,
        host: (await import('node:os')).hostname(),
        at: Date.now(),
      }),
    );
    await writeConfig({ contact: 'a@b.test' });
    expect(await readConfig()).toEqual({ contact: 'a@b.test' });
  });
});

describe('config lock and error hygiene (review fixes)', () => {
  it('waits for a live lock holder and proceeds when it releases', async () => {
    await mkdir(home, { recursive: true });
    const lock = join(home, 'config.json.lock');
    const { hostname } = await import('node:os');
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other' }));
    let done = false;
    const p = writeConfig({ contact: 'a@b.test' }).then((c) => {
      done = true;
      return c;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    await rm(lock);
    expect(await p).toEqual({ contact: 'a@b.test' });
  });

  it('an unreadable lock file older than 2 s is treated as stale', async () => {
    await mkdir(home, { recursive: true });
    const lock = join(home, 'config.json.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 5_000);
    await utimes(lock, old, old);
    await writeConfig({ contact: 'a@b.test' });
    expect(await readdir(home)).toEqual(['config.json']);
  });

  it('a broken config file never echoes its text in the error', async () => {
    await writeFile(configPath(), `{"providers": [{"apiKey": "sk-or-v1-CANARY000000000000" `);
    const err = await readConfig().catch((e: unknown) => e);
    expect(isVoxError(err) && err.code).toBe('CONFIG_INVALID');
    const all = JSON.stringify({ m: (err as Error).message, c: String((err as Error).cause) });
    expect(all).not.toContain('CANARY');
  });
});
