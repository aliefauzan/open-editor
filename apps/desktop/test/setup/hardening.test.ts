// Regression tests for review findings: process-group kill, locking, idle timeout, archive entry types,
// stale sweep, env hygiene, manifest path validation.
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../../src/engine-host/setup/run.ts';
import { readTextLimited } from '../../src/engine-host/setup/http.ts';
import { downloadVerified } from '../../src/engine-host/setup/download.ts';
import { extractArchive } from '../../src/engine-host/setup/extract.ts';
import { installComponent, sweepStale } from '../../src/engine-host/setup/install.ts';
import { checkPyEnv, ensurePyEnv, syncEnv, syncPyEnv } from '../../src/engine-host/setup/pyenv.ts';
import { toolPaths } from '../../src/engine-host/setup/paths.ts';
import { loadManifest, validateManifest } from '../../src/engine-host/setup/manifest.ts';
import { detectFfmpeg } from '../../src/engine-host/setup/ffmpeg.ts';
import { SetupError } from '../../src/engine-host/setup/errors.ts';
import type { ArchiveComponent } from '../../src/engine-host/setup/manifest.ts';
import { makeTarGz, noSignal, serve, sha256, tmp, writeScript } from './helpers.ts';

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe('runCommand', () => {
  test('abort kills the whole process group and settles only after the child closed', async () => {
    const dir = tmp();
    const pidFile = join(dir, 'pid');
    const script = writeScript(join(dir, 's'), `sleep 30 &\necho $! > '${pidFile}'\nwait`);
    const ac = new AbortController();
    const started = Date.now();
    const p = runCommand(script, [], { signal: ac.signal });
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
      await new Promise((r) => setTimeout(r, 10));
    }
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(5000);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 50));
    expect(gone(grandchild)).toBe(true);
  });

  test('a timeout is a COMMAND_FAILED, not an abort', async () => {
    const script = writeScript(join(tmp(), 's'), 'sleep 30');
    await expect(
      runCommand(script, [], { signal: noSignal(), timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
  });

  test('multibyte output survives chunk boundaries', async () => {
    const script = writeScript(join(tmp(), 's'), `printf '%s' "$(printf 'é%.0s' $(seq 1 5000))"`);
    const r = await runCommand(script, [], { signal: noSignal() });
    expect(r.stdout).toBe('é'.repeat(5000));
  });
});

describe('readTextLimited', () => {
  test('an oversize body is a SetupError, not a stream TypeError', async () => {
    const res = new Response('x'.repeat(5000));
    await expect(readTextLimited(res, 1000)).rejects.toMatchObject({ code: 'HTTP' });
  });
});

describe('downloadVerified idle timeout', () => {
  test('a stalled server is reported as NETWORK and leaves nothing behind', async () => {
    const srv = await serve({
      '/stall': (_req, res) => {
        res.writeHead(200, { 'content-length': 1_000_000 });
        res.write(Buffer.alloc(100));
      },
    });
    const dir = tmp();
    await expect(
      downloadVerified({
        url: `${srv.base}/stall`,
        destPath: join(dir, 'x'),
        sha256: sha256(''),
        signal: noSignal(),
        allowLoopbackHttp: true,
        idleTimeoutMs: 150,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('extractArchive entry types', () => {
  function archiveWith(setup: (dir: string) => void): string {
    const src = tmp('src');
    mkdirSync(join(src, 'pkg'));
    writeFileSync(join(src, 'pkg', 'real'), 'x');
    setup(join(src, 'pkg'));
    const out = join(tmp('out'), 'a.tgz');
    execFileSync('/usr/bin/tar', ['-czf', out, '-C', src, 'pkg']);
    return out;
  }
  const run = (archive: string) =>
    extractArchive({ archive, format: 'tar.gz', destDir: tmp('dest'), signal: noSignal() });

  test('symlinks, hard links and FIFOs are refused', async () => {
    await expect(
      run(archiveWith((d) => symlinkSync('/etc/passwd', join(d, 'link')))),
    ).rejects.toMatchObject({
      code: 'EXTRACT_UNSAFE',
    });
    await expect(
      run(archiveWith((d) => linkSync(join(d, 'real'), join(d, 'hard')))),
    ).rejects.toMatchObject({
      code: 'EXTRACT_UNSAFE',
    });
    await expect(
      run(archiveWith((d) => execFileSync('/usr/bin/mkfifo', [join(d, 'fifo')]))),
    ).rejects.toMatchObject({ code: 'EXTRACT_UNSAFE' });
  });

  test('a plain archive extracts', async () => {
    await run(archiveWith(() => undefined));
  });

  test('an archive that changes after verification is refused', async () => {
    const archive = archiveWith(() => undefined);
    await expect(
      extractArchive({
        archive,
        format: 'tar.gz',
        destDir: tmp('dest'),
        signal: noSignal(),
        expectSha256: sha256('not this'),
      }),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });
});

describe('concurrent installs of one component', () => {
  test('are serialized and both succeed', async () => {
    const archive = makeTarGz({ 'uv-aarch64-apple-darwin/uv': '#!/bin/sh\n' });
    const srv = await serve({ '/uv.tgz': archive });
    const tools = tmp();
    const c: ArchiveComponent = {
      kind: 'archive',
      id: 'uv',
      label: 'uv',
      version: '9.9.9',
      format: 'tar.gz',
      url: `${srv.base}/uv.tgz`,
      sha256: sha256(archive),
      size: archive.length,
      binary: 'uv-aarch64-apple-darwin/uv',
      licence: 'MIT',
      sizeBytesOnDisk: 1,
    };
    const ctx = { toolsDir: tools, signal: noSignal(), allowLoopbackHttp: true };
    await Promise.all([
      installComponent(c, ctx),
      installComponent(c, ctx),
      installComponent(c, ctx),
    ]);
    expect(readdirSync(join(tools, 'uv'))).toEqual(['9.9.9']);
    expect(readdirSync(tools).filter((n) => n.startsWith('.staging'))).toEqual([]);
  });
});

describe('sweepStale', () => {
  test('removes crash leftovers and keeps installs', async () => {
    const tools = tmp();
    mkdirSync(join(tools, '.staging-uv-abc'));
    mkdirSync(join(tools, '.downloads'));
    writeFileSync(join(tools, '.downloads', 'uv-1.tar.gz'), 'partial');
    mkdirSync(join(tools, 'uv', '1.0.0'), { recursive: true });
    mkdirSync(join(tools, 'uv', '1.0.0.old-deadbeef'), { recursive: true });
    await sweepStale(tools);
    expect(readdirSync(tools).sort()).toEqual(['.downloads', 'uv']);
    expect(readdirSync(join(tools, '.downloads'))).toEqual([]);
    expect(readdirSync(join(tools, 'uv'))).toEqual(['1.0.0']);
    await sweepStale(join(tools, 'does-not-exist'));
  });
});

describe('py-env hygiene', () => {
  function fixture() {
    const root = tmp();
    const pyDir = join(root, 'py');
    mkdirSync(pyDir);
    writeFileSync(join(pyDir, 'uv.lock'), 'lock\n');
    const toolsDir = join(root, 'tools');
    const log = join(root, 'log');
    const uv = writeScript(
      join(root, 'uv'),
      `echo "start $$ idx=$UV_INDEX_URL nocfg=$UV_NO_CONFIG pip=$PIP_INDEX_URL" >> '${log}'
sleep 0.3
mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; : > "$UV_PROJECT_ENVIRONMENT/bin/python"
echo "end $$" >> '${log}'`,
    );
    return { pyDir, toolsDir, uv, log, lock: join(pyDir, 'uv.lock') };
  }

  test('the sync ignores index/config overrides from the environment', async () => {
    const f = fixture();
    await ensurePyEnv({
      uvPath: f.uv,
      pyDir: f.pyDir,
      toolsDir: f.toolsDir,
      signal: noSignal(),
      env: {
        PATH: process.env['PATH'],
        UV_INDEX_URL: 'https://evil.example',
        PIP_INDEX_URL: 'https://evil.example',
      },
    });
    expect(readFileSync(f.log, 'utf8')).toContain('idx= nocfg=1 pip=');
    const env = syncEnv('/t', { HOME: '/h', UV_EXTRA_INDEX_URL: 'x', PYTHONPATH: 'y', LANG: 'C' });
    expect(env['HOME']).toBe('/h');
    expect(env['LANG']).toBe('C');
    expect(env['UV_EXTRA_INDEX_URL']).toBeUndefined();
    expect(env['PYTHONPATH']).toBeUndefined();
    expect(env['UV_PROJECT_ENVIRONMENT']).toBe(toolPaths('/t').pyEnv);
  });

  test('a repair queued behind a running sync does not overlap it', async () => {
    const f = fixture();
    const args = { uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() };
    await Promise.all([ensurePyEnv(args), syncPyEnv(args)]);
    const lines = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[0]);
    expect(lines).toEqual(['start', 'end', 'start', 'end']);
  });

  test('a deleted interpreter makes the env missing even though the hash file is there', async () => {
    const f = fixture();
    await ensurePyEnv({ uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() });
    expect((await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lock })).state).toBe('current');
    execFileSync('/bin/rm', [join(toolPaths(f.toolsDir).pyEnv, 'bin', 'python')]);
    expect((await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lock })).state).toBe('missing');
  });
});

describe('manifest path validation', () => {
  const clone = () =>
    structuredClone(loadManifest()) as unknown as { components: Array<Record<string, unknown>> };
  test('rejects ids, versions and binaries that could leave the tools folder', () => {
    for (const [key, value] of [
      ['id', '../evil'],
      ['id', 'Has Space'],
      ['version', '../1'],
      ['binary', '../uv'],
      ['binary', '/usr/bin/uv'],
      ['binary', 'a//b'],
    ] as const) {
      const m = clone();
      m.components[0]![key] = value;
      expect(() => validateManifest(m), `${key}=${value}`).toThrow(SetupError);
    }
    const m = clone();
    m.components[2]!['sumsName'] = '../x';
    expect(() => validateManifest(m)).toThrow(/sumsName/);
  });
});

describe('ffmpeg detection trusts only absolute PATH entries', () => {
  test('a relative PATH entry holding a brew is ignored', async () => {
    const dir = tmp();
    writeScript(join(dir, 'brew'), 'echo /tmp');
    const r = await detectFfmpeg({
      env: { PATH: '.', VOX_NO_BREW_FALLBACK: '1' },
      signal: noSignal(),
    });
    expect(r.state).toBe('brew-missing');
  });
});
