// Installs one downloadable component into the tools folder: download -> SHA-256 check -> extract into
// a staging folder -> rename into place. Nothing is ever written into the app bundle (S31).

import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { downloadVerified } from './download.ts';
import { SetupError, isAbortError } from './errors.ts';
import { withLock } from './lock.ts';
import { extractArchive } from './extract.ts';
import { sha256File } from './hash.ts';
import { fetchChecked, readTextLimited } from './http.ts';
import type { ArchiveComponent, BinaryComponent, Component } from './manifest.ts';
import { toolPaths } from './paths.ts';
import { progress } from './types.ts';
import type { ProgressSink } from './types.ts';

export interface InstallContext {
  toolsDir: string;
  signal: AbortSignal;
  onProgress?: ProgressSink;
  fetchImpl?: typeof fetch;
  /** Tests only: allow http to 127.0.0.1 / localhost. */
  allowLoopbackHttp?: boolean;
}

export interface InstallResult {
  id: string;
  path: string;
  version: string;
}

const MARKER = '.vox-component.json';

export function componentDir(toolsDir: string, c: ArchiveComponent | BinaryComponent): string {
  return c.kind === 'archive' ? join(toolsDir, c.id, c.version) : join(toolsDir, c.id);
}

export function componentBinaryPath(
  toolsDir: string,
  c: ArchiveComponent | BinaryComponent,
): string {
  return c.kind === 'archive'
    ? join(componentDir(toolsDir, c), c.binary)
    : join(toolsDir, c.id, c.id);
}

export type FileState = 'ready' | 'missing' | 'modified';

/**
 * Cheap check: the executable exists. `deep` also re-hashes a pinned archive's binary against the hash
 * recorded at install time (used by repair and doctor, not on every launch).
 */
export async function componentState(
  toolsDir: string,
  c: ArchiveComponent | BinaryComponent,
  opts: { deep?: boolean } = {},
): Promise<FileState> {
  const bin = componentBinaryPath(toolsDir, c);
  try {
    const s = await stat(bin);
    if (!s.isFile()) return 'missing';
    await access(bin, constants.X_OK);
  } catch {
    return 'missing';
  }
  if (opts.deep === true && c.kind === 'archive') {
    try {
      const marker = JSON.parse(
        await readFile(join(componentDir(toolsDir, c), MARKER), 'utf8'),
      ) as {
        binarySha256?: string;
      };
      if (marker.binarySha256 !== (await sha256File(bin))) return 'modified';
    } catch {
      return 'modified';
    }
  }
  return 'ready';
}

export async function installComponent(c: Component, ctx: InstallContext): Promise<InstallResult> {
  if (c.kind !== 'archive' && c.kind !== 'binary') {
    throw new SetupError(
      'NOT_INSTALLABLE',
      c.kind === 'external'
        ? `${c.id} is installed by the user (Homebrew); the app never downloads it`
        : `${c.id} is not a downloadable component`,
    );
  }
  try {
    return await withLock(`install:${ctx.toolsDir}:${c.id}`, () =>
      c.kind === 'archive' ? installArchive(c, ctx) : installBinary(c, ctx),
    );
  } catch (e) {
    if (!isAbortError(e)) {
      progress(ctx.onProgress, c.id, 'error', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }
}

function net(ctx: InstallContext) {
  return {
    signal: ctx.signal,
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
    ...(ctx.allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp: ctx.allowLoopbackHttp }),
  };
}

async function installArchive(c: ArchiveComponent, ctx: InstallContext): Promise<InstallResult> {
  const { downloads } = toolPaths(ctx.toolsDir);
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  const archivePath = join(downloads, `${c.id}-${c.version}.${c.format}`);
  let staging: string | undefined;
  try {
    const dl = await downloadVerified({
      url: c.url,
      destPath: archivePath,
      sha256: c.sha256,
      size: c.size,
      ...net(ctx),
      onProgress: (got, total) =>
        progress(ctx.onProgress, c.id, 'download', {
          receivedBytes: got,
          ...(total === undefined ? {} : { totalBytes: total }),
        }),
    });
    progress(ctx.onProgress, c.id, 'verify', { message: `SHA-256 ${dl.sha256}` });

    staging = await mkdtemp(join(ctx.toolsDir, `.staging-${c.id}-`));
    progress(ctx.onProgress, c.id, 'extract');
    await extractArchive({
      archive: archivePath,
      format: c.format,
      destDir: staging,
      signal: ctx.signal,
      expectSha256: c.sha256,
    });

    const binary = join(staging, c.binary);
    const real = await realpath(binary).catch(() => undefined);
    const rootReal = await realpath(staging);
    const info = real === undefined ? undefined : await lstat(real);
    if (real === undefined || info === undefined || !info.isFile()) {
      throw new SetupError('BINARY_MISSING', `${c.binary} not found in the ${c.id} archive`);
    }
    if (!real.startsWith(rootReal + sep)) {
      throw new SetupError('EXTRACT_UNSAFE', `${c.binary} resolves outside the staging folder`);
    }
    await chmod(real, 0o755);
    await writeFile(
      join(staging, MARKER),
      JSON.stringify({
        id: c.id,
        version: c.version,
        archiveSha256: c.sha256,
        binarySha256: await sha256File(real, ctx.signal),
        installedAt: new Date().toISOString(),
      }),
    );

    progress(ctx.onProgress, c.id, 'install');
    await swapIn(staging, componentDir(ctx.toolsDir, c));
    staging = undefined;
    progress(ctx.onProgress, c.id, 'done');
    return { id: c.id, path: componentBinaryPath(ctx.toolsDir, c), version: c.version };
  } finally {
    await rm(archivePath, { force: true });
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
  }
}

/** Atomically puts `staging` at `target`; an existing target is moved aside first and removed after. */
async function swapIn(staging: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const aside = `${target}.old-${randomBytes(4).toString('hex')}`;
  let hadOld = true;
  try {
    await rename(target, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    hadOld = false;
  }
  try {
    await rename(staging, target);
  } catch (e) {
    if (hadOld) await rename(aside, target).catch(() => undefined);
    throw e;
  }
  if (hadOld) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

async function installBinary(c: BinaryComponent, ctx: InstallContext): Promise<InstallResult> {
  const { downloads } = toolPaths(ctx.toolsDir);
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  const tmpPath = join(downloads, `${c.id}.download`);
  try {
    const sumsRes = await fetchChecked(c.sumsUrl, net(ctx));
    const sums = await readTextLimited(sumsRes, 1024 * 1024);
    const line = sums
      .split('\n')
      .map((l) => /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(l))
      .find((m) => m !== null && m[2] === c.sumsName);
    const expected = line?.[1]?.toLowerCase();
    if (expected === undefined) {
      throw new SetupError(
        'HASH_MISMATCH',
        `no SHA-256 for ${c.sumsName} in the published checksum list`,
      );
    }
    const dl = await downloadVerified({
      url: c.url,
      destPath: tmpPath,
      sha256: expected,
      maxBytes: 200 * 1024 * 1024,
      ...net(ctx),
      onProgress: (got, total) =>
        progress(ctx.onProgress, c.id, 'download', {
          receivedBytes: got,
          ...(total === undefined ? {} : { totalBytes: total }),
        }),
    });
    progress(ctx.onProgress, c.id, 'verify', { message: `SHA-256 ${dl.sha256}` });
    await chmod(tmpPath, 0o755);
    ctx.signal.throwIfAborted();
    progress(ctx.onProgress, c.id, 'install');
    const dir = join(ctx.toolsDir, c.id);
    await mkdir(dir, { recursive: true });
    await rename(tmpPath, componentBinaryPath(ctx.toolsDir, c));
    await writeFile(
      join(dir, MARKER),
      JSON.stringify({ id: c.id, binarySha256: dl.sha256, installedAt: new Date().toISOString() }),
    );
    progress(ctx.onProgress, c.id, 'done');
    return { id: c.id, path: componentBinaryPath(ctx.toolsDir, c), version: c.version };
  } finally {
    await rm(tmpPath, { force: true });
  }
}

/**
 * Removes leftovers of crashed or killed installs (staging folders, moved-aside old versions, partial
 * downloads). Call only while no install runs in this process.
 */
export async function sweepStale(toolsDir: string): Promise<void> {
  const rmAll = (p: string) => rm(p, { recursive: true, force: true }).catch(() => undefined);
  const top = await readdir(toolsDir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [] as string[];
    throw e;
  });
  for (const name of top) {
    const p = join(toolsDir, name);
    if (name.startsWith('.staging-')) await rmAll(p);
    else if (name === '.downloads') {
      for (const f of await readdir(p).catch(() => [])) await rmAll(join(p, f));
    } else if (!name.startsWith('.')) {
      for (const f of await readdir(p).catch(() => [])) {
        if (/\.old-[0-9a-f]+$/.test(f)) await rmAll(join(p, f));
      }
    }
  }
}
