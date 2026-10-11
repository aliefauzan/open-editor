// Orchestration against local fixtures: status, install-all with progress, repair of one component,
// and "a missing tool disables only its stages". No network; fake uv / deno / yt-dlp / brew.
import { describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  disabledStages,
  getSetupStatus,
  installAll,
  repairComponent,
} from '../../src/engine-host/setup/setup.ts';
import type { SetupContext } from '../../src/engine-host/setup/setup.ts';
import type { Manifest } from '../../src/engine-host/setup/manifest.ts';
import type { SetupProgressEvent } from '../../src/engine-host/setup/types.ts';
import { makeTarGz, makeZip, noSignal, serve, sha256, tmp, writeScript } from './helpers.ts';

const FAKE_UV = `#!/bin/sh
/bin/mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
echo "$@" >> "$UV_PROJECT_ENVIRONMENT/../uv-sync-calls"
: > "$UV_PROJECT_ENVIRONMENT/bin/python"
`;

async function fixture(opts: { badDenoHash?: boolean } = {}) {
  const uvTar = makeTarGz({ 'uv-aarch64-apple-darwin/uv': FAKE_UV });
  const denoZip = makeZip({ deno: '#!/bin/sh\necho deno 2.9.5\n' });
  const ytdlp = Buffer.from('#!/bin/sh\necho 2026.09.01\n');
  const srv = await serve({
    '/uv.tgz': uvTar,
    '/deno.zip': denoZip,
    '/yt-dlp_macos': ytdlp,
    '/SHA2-256SUMS': `${sha256(ytdlp)}  yt-dlp_macos\n`,
  });
  const manifest: Manifest = {
    schema: 'vox-setup-manifest/1',
    components: [
      {
        kind: 'archive',
        id: 'uv',
        label: 'uv',
        version: '9.9.9',
        format: 'tar.gz',
        url: `${srv.base}/uv.tgz`,
        sha256: sha256(uvTar),
        size: uvTar.length,
        binary: 'uv-aarch64-apple-darwin/uv',
        licence: 'MIT OR Apache-2.0',
        sizeBytesOnDisk: 100,
      },
      {
        kind: 'archive',
        id: 'deno',
        label: 'deno',
        version: '2.9.5',
        format: 'zip',
        url: `${srv.base}/deno.zip`,
        sha256: opts.badDenoHash ? sha256('x') : sha256(denoZip),
        size: denoZip.length,
        binary: 'deno',
        licence: 'MIT',
        sizeBytesOnDisk: 100,
      },
      {
        kind: 'binary',
        id: 'yt-dlp',
        label: 'yt-dlp',
        version: 'latest',
        url: `${srv.base}/yt-dlp_macos`,
        sumsUrl: `${srv.base}/SHA2-256SUMS`,
        sumsName: 'yt-dlp_macos',
        licence: 'Unlicense',
        sizeBytesOnDisk: 100,
      },
      {
        kind: 'uv-sync',
        id: 'python-env',
        label: 'Python environment',
        licence: 'various',
        sizeBytesOnDisk: 1_500_000_000,
      },
      { kind: 'external', id: 'ffmpeg', label: 'ffmpeg', licence: 'LGPL/GPL', sizeBytesOnDisk: 0 },
      {
        kind: 'delegated',
        id: 'chrome',
        label: 'Chrome for HyperFrames',
        licence: 'BSD',
        sizeBytesOnDisk: 250_000_000,
      },
    ],
  };
  const root = tmp();
  const pyDir = join(root, 'bundle', 'py');
  mkdirSync(pyDir, { recursive: true });
  writeFileSync(join(pyDir, 'uv.lock'), 'lock\n');
  const toolsDir = join(root, 'tools');
  // fake brew + ffmpeg prefix, ffmpeg not yet installed
  const brewBin = join(root, 'brew-bin');
  const prefix = join(root, 'brew-opt', 'ffmpeg');
  writeScript(join(brewBin, 'brew'), `echo '${prefix}'`);
  let chrome = false;
  const events: SetupProgressEvent[] = [];
  const ctx: SetupContext = {
    toolsDir,
    pyDir,
    manifest,
    env: { PATH: brewBin, VOX_NO_BREW_FALLBACK: '1' },
    signal: noSignal(),
    allowLoopbackHttp: true,
    onProgress: (e) => events.push(e),
    delegates: {
      chrome: {
        check: async () => chrome,
        install: async () => {
          chrome = true;
        },
      },
    },
  };
  const installFfmpeg = () => {
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeScript(join(prefix, 'bin', 'ffmpeg'), 'echo "ffmpeg version 8.1.2"');
    writeScript(join(prefix, 'bin', 'ffprobe'), 'echo "ffprobe version 8.1.2"');
  };
  const syncCalls = () => {
    const f = join(toolsDir, 'uv-sync-calls');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0;
  };
  return { ctx, srv, events, installFfmpeg, syncCalls, toolsDir, root };
}

const state = (s: Awaited<ReturnType<typeof getSetupStatus>>, id: string) =>
  s.components.find((c) => c.id === id)?.state;

describe('getSetupStatus', () => {
  test('fresh machine: everything missing, every stage disabled and labelled', async () => {
    const f = await fixture();
    const s = await getSetupStatus(f.ctx);
    expect(s.ready).toBe(false);
    expect(s.components.map((c) => [c.id, c.state])).toEqual([
      ['uv', 'missing'],
      ['deno', 'missing'],
      ['yt-dlp', 'missing'],
      ['python-env', 'missing'],
      ['ffmpeg', 'missing'],
      ['chrome', 'missing'],
    ]);
    expect(s.components.find((c) => c.id === 'python-env')?.sizeBytes).toBe(1_500_000_000);
    expect(s.ffmpeg.state).toBe('ffmpeg-missing');
    expect(Object.keys(s.disabledStages).length).toBeGreaterThan(5);
    expect(f.srv.hits).toEqual([]); // status never touches the network
  });
});

describe('installAll', () => {
  test('installs everything we may download; ffmpeg is left to the user; progress per component', async () => {
    const f = await fixture();
    const r = await installAll(f.ctx);
    expect(r.failed).toEqual([]);
    expect(r.installed).toEqual(['uv', 'deno', 'yt-dlp', 'python-env', 'chrome']);
    expect(f.srv.hits.sort()).toEqual(['/SHA2-256SUMS', '/deno.zip', '/uv.tgz', '/yt-dlp_macos']);
    expect(f.syncCalls()).toBe(1);
    const done = f.events.filter((e) => e.phase === 'done').map((e) => e.component);
    expect(done).toEqual(['uv', 'deno', 'yt-dlp', 'python-env', 'chrome']);
    const s = await getSetupStatus(f.ctx);
    expect(s.components.filter((c) => c.state !== 'ready').map((c) => c.id)).toEqual(['ffmpeg']);
    expect(s.ready).toBe(false);
    // only ffmpeg-dependent stages are disabled, each labelled with why
    for (const blockers of Object.values(s.disabledStages)) expect(blockers).toEqual(['ffmpeg']);
    expect(s.disabledStages['ingest.document']).toBeUndefined(); // needs python only
  });

  test('"Check again" after `brew install ffmpeg` reaches Ready', async () => {
    const f = await fixture();
    await installAll(f.ctx);
    expect((await getSetupStatus(f.ctx)).ready).toBe(false);
    f.installFfmpeg();
    const s = await getSetupStatus(f.ctx);
    expect(state(s, 'ffmpeg')).toBe('ready');
    expect(s.ready).toBe(true);
    expect(s.disabledStages).toEqual({});
  });

  test('a second run changes nothing', async () => {
    const f = await fixture();
    await installAll(f.ctx);
    const hits = f.srv.hits.length;
    const r = await installAll(f.ctx);
    expect(r.installed).toEqual([]);
    expect(r.skipped).toEqual(
      expect.arrayContaining(['uv', 'deno', 'yt-dlp', 'python-env', 'chrome']),
    );
    expect(f.srv.hits.length).toBe(hits);
    expect(f.syncCalls()).toBe(1);
  });

  test('S16 + isolation: a refused hash fails that component only', async () => {
    const f = await fixture({ badDenoHash: true });
    const r = await installAll(f.ctx);
    expect(r.failed.map((x) => [x.id, x.code])).toEqual([['deno', 'HASH_MISMATCH']]);
    expect(r.installed).toEqual(['uv', 'yt-dlp', 'python-env', 'chrome']);
    f.installFfmpeg();
    const s = await getSetupStatus(f.ctx);
    expect(state(s, 'deno')).toBe('missing');
    // a missing deno disables URL ingest and nothing else
    expect(Object.keys(s.disabledStages)).toEqual(['ingest.url']);
    expect(s.disabledStages['ingest.url']).toEqual(['deno']);
    expect(f.events.some((e) => e.component === 'deno' && e.phase === 'error')).toBe(true);
  });

  test('missing uv blocks the Python environment but not deno or yt-dlp', async () => {
    const f = await fixture();
    f.ctx.manifest = {
      ...f.ctx.manifest!,
      components: f.ctx.manifest!.components.map((c) =>
        c.id === 'uv' && c.kind === 'archive' ? { ...c, sha256: sha256('bad') } : c,
      ),
    };
    const r = await installAll(f.ctx);
    expect(r.failed.map((x) => x.id).sort()).toEqual(['python-env', 'uv']);
    expect(r.installed).toEqual(['deno', 'yt-dlp', 'chrome']);
    expect(r.failed.find((x) => x.id === 'python-env')?.code).toBe('NO_UV');
  });

  test('a bundled uv is used as is: no uv download, sync runs with it', async () => {
    const f = await fixture();
    const bundled = writeScript(
      join(f.root, 'bundle', 'bin', 'uv'),
      FAKE_UV.split('\n').slice(1).join('\n'),
    );
    f.ctx.bundledUvPath = bundled;
    const r = await installAll(f.ctx);
    expect(r.installed).not.toContain('uv');
    expect(r.skipped).toContain('uv');
    expect(f.srv.hits).not.toContain('/uv.tgz');
    expect(f.syncCalls()).toBe(1);
  });

  test('an abort stops the run', async () => {
    const f = await fixture();
    const ac = new AbortController();
    ac.abort();
    await expect(installAll({ ...f.ctx, signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('repairComponent', () => {
  test('re-runs exactly one component', async () => {
    const f = await fixture();
    await installAll(f.ctx);
    const before = [...f.srv.hits];
    await repairComponent('deno', f.ctx);
    expect(f.srv.hits.slice(before.length)).toEqual(['/deno.zip']);
    expect(f.syncCalls()).toBe(1);
    await repairComponent('python-env', f.ctx);
    expect(f.syncCalls()).toBe(2);
    expect(f.srv.hits.slice(before.length)).toEqual(['/deno.zip']);
  });

  test('ffmpeg cannot be repaired by downloading (D-05)', async () => {
    const f = await fixture();
    await expect(repairComponent('ffmpeg', f.ctx)).rejects.toMatchObject({
      code: 'NOT_INSTALLABLE',
    });
    await expect(repairComponent('nope', f.ctx)).rejects.toMatchObject({ code: 'NOT_INSTALLABLE' });
    expect(f.srv.hits).toEqual([]);
  });
});

describe('disabledStages', () => {
  test('is derived purely from component states', () => {
    const mk = (missing: string[]) =>
      ['uv', 'deno', 'yt-dlp', 'python-env', 'ffmpeg', 'chrome'].map((id) => ({
        id,
        state: missing.includes(id) ? ('missing' as const) : ('ready' as const),
      }));
    expect(disabledStages(mk([]))).toEqual({});
    expect(Object.keys(disabledStages(mk(['yt-dlp'])))).toEqual(['ingest.url']);
    expect(Object.keys(disabledStages(mk(['chrome']))).sort()).toEqual(['export', 'render']);
    const py = Object.keys(disabledStages(mk(['python-env'])));
    expect(py).toEqual(expect.arrayContaining(['transcribe', 'facetrack', 'ingest.document']));
    expect(py).not.toContain('render');
    expect(py).not.toContain('ingest.url');
  });
});
