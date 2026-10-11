import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  componentBinaryPath,
  componentState,
  installComponent,
} from '../../src/engine-host/setup/install.ts';
import type { ArchiveComponent, BinaryComponent } from '../../src/engine-host/setup/manifest.ts';
import type { SetupProgressEvent } from '../../src/engine-host/setup/types.ts';
import { SetupError } from '../../src/engine-host/setup/errors.ts';
import { makeTarGz, makeZip, noSignal, serve, sha256, tmp } from './helpers.ts';

function archiveComponent(
  over: Partial<ArchiveComponent> & { url: string; archive: Buffer },
): ArchiveComponent {
  const { archive, ...rest } = over;
  return {
    kind: 'archive',
    id: 'uv',
    label: 'uv',
    version: '9.9.9',
    format: 'tar.gz',
    binary: 'uv-aarch64-apple-darwin/uv',
    sha256: sha256(archive),
    size: archive.length,
    licence: 'MIT OR Apache-2.0',
    sizeBytesOnDisk: 1000,
    ...rest,
  } as ArchiveComponent;
}

const ctxFor = (toolsDir: string, events: SetupProgressEvent[] = []) => ({
  toolsDir,
  signal: noSignal(),
  allowLoopbackHttp: true,
  onProgress: (e: SetupProgressEvent) => events.push(e),
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SetupError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

describe('installComponent: archive', () => {
  test('tar.gz: installs the binary executable under <tools>/<id>/<version>, cleans up, emits progress', async () => {
    const archive = makeTarGz({
      'uv-aarch64-apple-darwin/uv': '#!/bin/sh\necho uv\n',
      'uv-aarch64-apple-darwin/uvx': '#!/bin/sh\n',
    });
    const srv = await serve({ '/uv.tgz': archive });
    const tools = tmp();
    const events: SetupProgressEvent[] = [];
    const comp = archiveComponent({ url: `${srv.base}/uv.tgz`, archive });
    const r = await installComponent(comp, ctxFor(tools, events));
    expect(r.path).toBe(join(tools, 'uv', '9.9.9', 'uv-aarch64-apple-darwin', 'uv'));
    expect(componentBinaryPath(tools, comp)).toBe(r.path);
    expect(statSync(r.path).mode & 0o111).not.toBe(0);
    expect(await componentState(tools, comp)).toBe('ready');
    // nothing but the component folder stays in the tools dir
    expect(readdirSync(tools).sort()).toEqual(['.downloads', 'uv']);
    expect(readdirSync(join(tools, '.downloads'))).toEqual([]);
    expect(events.every((e) => e.type === 'setup.progress' && e.component === 'uv')).toBe(true);
    const phases = events.map((e) => e.phase);
    for (const p of ['download', 'verify', 'extract', 'install', 'done'] as const) {
      expect(phases).toContain(p);
    }
    expect(phases.indexOf('download')).toBeLessThan(phases.indexOf('extract'));
    expect(phases.at(-1)).toBe('done');
  });

  test('zip archives install too', async () => {
    const archive = makeZip({ deno: '#!/bin/sh\necho deno\n' });
    const srv = await serve({ '/deno.zip': archive });
    const tools = tmp();
    const comp = archiveComponent({
      id: 'deno',
      label: 'deno',
      format: 'zip',
      binary: 'deno',
      url: `${srv.base}/deno.zip`,
      archive,
    });
    const r = await installComponent(comp, ctxFor(tools));
    expect(readFileSync(r.path, 'utf8')).toContain('echo deno');
    expect(statSync(r.path).mode & 0o111).not.toBe(0);
  });

  test('S16: a hash mismatch installs nothing and leaves no partial state', async () => {
    const archive = makeTarGz({ 'uv-aarch64-apple-darwin/uv': 'x' });
    const srv = await serve({ '/uv.tgz': archive });
    const tools = tmp();
    const comp = archiveComponent({ url: `${srv.base}/uv.tgz`, archive, sha256: sha256('other') });
    const events: SetupProgressEvent[] = [];
    expect(await codeOf(installComponent(comp, ctxFor(tools, events)))).toBe('HASH_MISMATCH');
    expect(existsSync(join(tools, 'uv'))).toBe(false);
    expect(readdirSync(tools).filter((n) => n.startsWith('.staging'))).toEqual([]);
    expect(readdirSync(join(tools, '.downloads'))).toEqual([]);
    expect(events.at(-1)).toMatchObject({ phase: 'error', component: 'uv' });
    expect(await componentState(tools, comp)).toBe('missing');
  });

  test('refuses archives with path traversal or links', async () => {
    const traversal = makeTarGz({ 'uv-aarch64-apple-darwin/uv': 'x' }, ['-s', ',^uv-,../uv-,']);
    const srv = await serve({ '/t.tgz': traversal });
    const tools = tmp();
    const comp = archiveComponent({ url: `${srv.base}/t.tgz`, archive: traversal });
    expect(await codeOf(installComponent(comp, ctxFor(tools)))).toBe('EXTRACT_UNSAFE');
    expect(existsSync(join(tools, 'uv'))).toBe(false);
  });

  test('a missing binary inside a verified archive fails with BINARY_MISSING', async () => {
    const archive = makeTarGz({ 'other/file': 'x' });
    const srv = await serve({ '/a.tgz': archive });
    const tools = tmp();
    const comp = archiveComponent({ url: `${srv.base}/a.tgz`, archive });
    expect(await codeOf(installComponent(comp, ctxFor(tools)))).toBe('BINARY_MISSING');
    expect(existsSync(join(tools, 'uv'))).toBe(false);
  });

  test('repair: reinstalling over a modified install restores the pinned binary', async () => {
    const archive = makeTarGz({ 'uv-aarch64-apple-darwin/uv': '#!/bin/sh\necho good\n' });
    const srv = await serve({ '/uv.tgz': archive });
    const tools = tmp();
    const comp = archiveComponent({ url: `${srv.base}/uv.tgz`, archive });
    const r = await installComponent(comp, ctxFor(tools));
    writeFileSync(r.path, '#!/bin/sh\necho tampered\n');
    expect(await componentState(tools, comp)).toBe('ready'); // cheap check: exists and executable
    expect(await componentState(tools, comp, { deep: true })).toBe('modified');
    await installComponent(comp, ctxFor(tools));
    expect(await componentState(tools, comp, { deep: true })).toBe('ready');
    expect(readFileSync(r.path, 'utf8')).toContain('echo good');
    expect(readdirSync(join(tools, 'uv'))).toEqual(['9.9.9']);
  });

  test('an aborted install leaves nothing behind', async () => {
    const archive = makeTarGz({ 'uv-aarch64-apple-darwin/uv': 'x' });
    const srv = await serve({
      '/uv.tgz': (_req, res) => {
        res.writeHead(200, { 'content-length': archive.length });
        res.write(archive.subarray(0, 10));
      },
    });
    const tools = tmp();
    const ac = new AbortController();
    const comp = archiveComponent({ url: `${srv.base}/uv.tgz`, archive });
    const p = installComponent(comp, {
      ...ctxFor(tools),
      signal: ac.signal,
      onProgress: (e) => {
        if (e.phase === 'download' && (e.receivedBytes ?? 0) > 0) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(tools, 'uv'))).toBe(false);
  });
});

describe('installComponent: binary with a published checksum list (yt-dlp)', () => {
  const bin = Buffer.from('#!/bin/sh\necho yt-dlp\n');
  const comp = (base: string, sums: string): BinaryComponent => ({
    kind: 'binary',
    id: 'yt-dlp',
    label: 'yt-dlp',
    version: 'latest',
    url: `${base}/yt-dlp_macos`,
    sumsUrl: `${base}/SHA2-256SUMS`,
    sumsName: 'yt-dlp_macos',
    licence: 'Unlicense',
    sizeBytesOnDisk: bin.length,
    sha256: sums,
  });

  test('verifies against the sums file and installs one executable', async () => {
    const srv = await serve({
      '/yt-dlp_macos': bin,
      '/SHA2-256SUMS': `${'a'.repeat(64)}  other\n${sha256(bin)}  yt-dlp_macos\n`,
    });
    const tools = tmp();
    const c = comp(srv.base, '');
    const r = await installComponent(c, ctxFor(tools));
    expect(r.path).toBe(join(tools, 'yt-dlp', 'yt-dlp'));
    expect(statSync(r.path).mode & 0o111).not.toBe(0);
    expect(await componentState(tools, c)).toBe('ready');
  });

  test('S16: a binary that does not match the sums file is refused', async () => {
    const srv = await serve({
      '/yt-dlp_macos': bin,
      '/SHA2-256SUMS': `${'b'.repeat(64)}  yt-dlp_macos\n`,
    });
    const tools = tmp();
    expect(await codeOf(installComponent(comp(srv.base, ''), ctxFor(tools)))).toBe('HASH_MISMATCH');
    expect(existsSync(join(tools, 'yt-dlp', 'yt-dlp'))).toBe(false);
  });

  test('a sums file without our asset is an error', async () => {
    const srv = await serve({
      '/yt-dlp_macos': bin,
      '/SHA2-256SUMS': `${'b'.repeat(64)}  other\n`,
    });
    expect(await codeOf(installComponent(comp(srv.base, ''), ctxFor(tmp())))).toBe('HASH_MISMATCH');
  });
});

describe('installComponent: kinds that are not downloaded', () => {
  test('ffmpeg is never installable (D-05)', async () => {
    const c = {
      kind: 'external',
      id: 'ffmpeg',
      label: 'ffmpeg',
      licence: 'x',
      sizeBytesOnDisk: 0,
    } as const;
    expect(await codeOf(installComponent(c as never, ctxFor(tmp())))).toBe('NOT_INSTALLABLE');
  });
});
