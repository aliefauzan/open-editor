// Shared setup fixture: a loopback server with fake uv / deno / yt-dlp, a fixture manifest, a bundled
// py/ with a uv.lock, a fake brew whose ffmpeg appears on demand and a Chrome delegate stand-in.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupContext } from '../../src/engine-host/setup/setup.ts';
import type { Manifest } from '../../src/engine-host/setup/manifest.ts';
import type { SetupProgressEvent } from '../../src/engine-host/setup/types.ts';
import { makeTarGz, makeZip, noSignal, serve, sha256, tmp, writeScript } from './helpers.ts';

export const FAKE_UV = `#!/bin/sh
/bin/mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
echo "$@" >> "$UV_PROJECT_ENVIRONMENT/../uv-sync-calls"
: > "$UV_PROJECT_ENVIRONMENT/bin/python"
`;

export async function fixture(opts: { badDenoHash?: boolean } = {}) {
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
