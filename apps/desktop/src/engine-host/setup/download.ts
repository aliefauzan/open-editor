// S16: download to a temp file next to the destination, check size and SHA-256, then rename.
// A refused download leaves no file behind and never touches an existing destination.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SetupError } from './errors.ts';
import { sha256File } from './hash.ts';
import { fetchChecked } from './http.ts';

export interface DownloadOptions {
  url: string;
  destPath: string;
  /** Lower-case hex SHA-256 of the exact bytes. */
  sha256: string;
  /** Exact byte size, when the pin records one. */
  size?: number;
  signal: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
  fetchImpl?: typeof fetch;
  allowLoopbackHttp?: boolean;
  /** Hard cap when `size` is unknown. Default 2 GB. */
  maxBytes?: number;
  /** Abort when no bytes arrive for this long. Default 60 s. */
  idleTimeoutMs?: number;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  size: number;
}

export async function downloadVerified(opts: DownloadOptions): Promise<DownloadResult> {
  await mkdir(dirname(opts.destPath), { recursive: true, mode: 0o700 });
  const part = join(
    dirname(opts.destPath),
    `.${basename(opts.destPath)}.${randomBytes(6).toString('hex')}.part`,
  );
  const maxBytes = opts.size ?? opts.maxBytes ?? 2 * 1024 ** 3;
  const idleMs = opts.idleTimeoutMs ?? 60_000;
  const hash = createHash('sha256');
  let received = 0;

  const idle = new AbortController();
  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      idle.abort();
    }, idleMs);
  };
  const signal = AbortSignal.any([opts.signal, idle.signal]);
  const net = {
    signal,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp: opts.allowLoopbackHttp }),
  };
  try {
    arm();
    const res = await fetchChecked(opts.url, net);
    const lengthHeader = res.headers.get('content-length');
    const total = lengthHeader === null ? opts.size : Number(lengthHeader);
    if (res.body === null) throw new SetupError('HTTP', 'empty response body');
    const fh = await open(part, 'wx', 0o600);
    try {
      for await (const chunk of res.body) {
        arm();
        received += chunk.byteLength;
        if (received > maxBytes) {
          throw new SetupError('SIZE_MISMATCH', `download exceeds ${maxBytes} bytes`);
        }
        hash.update(chunk);
        await fh.writeFile(chunk); // writes every byte, unlike write()
        opts.onProgress?.(received, total);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    opts.signal.throwIfAborted();
    if (opts.size !== undefined && received !== opts.size) {
      throw new SetupError('SIZE_MISMATCH', `expected ${opts.size} bytes, got ${received}`);
    }
    const actual = hash.digest('hex');
    // The hash above covers the bytes received; this one covers the bytes on disk.
    const onDisk = await sha256File(part, opts.signal);
    if (actual !== opts.sha256.toLowerCase() || onDisk !== actual) {
      throw new SetupError(
        'HASH_MISMATCH',
        `SHA-256 mismatch for ${new URL(opts.url).pathname}: expected ${opts.sha256}, got ${onDisk}`,
      );
    }
    await rename(part, opts.destPath);
    return { path: opts.destPath, sha256: actual, size: received };
  } catch (e) {
    await rm(part, { force: true });
    if (stalled && !opts.signal.aborted) {
      throw new SetupError('NETWORK', `download stalled: no data for ${idleMs} ms`, { cause: e });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
