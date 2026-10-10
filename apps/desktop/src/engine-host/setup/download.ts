// S16: download to a temp file next to the destination, check size and SHA-256, then rename.
// A refused download leaves no file behind and never touches an existing destination.

import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SetupError } from './errors.ts';
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
}

export interface DownloadResult {
  path: string;
  sha256: string;
  size: number;
}

export async function downloadVerified(opts: DownloadOptions): Promise<DownloadResult> {
  await mkdir(dirname(opts.destPath), { recursive: true });
  const part = join(
    dirname(opts.destPath),
    `.${basename(opts.destPath)}.${randomBytes(6).toString('hex')}.part`,
  );
  const maxBytes = opts.size ?? opts.maxBytes ?? 2 * 1024 ** 3;
  const hash = createHash('sha256');
  let received = 0;
  const net = {
    signal: opts.signal,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp: opts.allowLoopbackHttp }),
  };
  try {
    const res = await fetchChecked(opts.url, net);
    const lengthHeader = res.headers.get('content-length');
    const total = lengthHeader === null ? opts.size : Number(lengthHeader);
    if (res.body === null) throw new SetupError('HTTP', 'empty response body');
    const fh = await open(part, 'wx', 0o600);
    try {
      for await (const chunk of res.body) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          throw new SetupError('SIZE_MISMATCH', `download exceeds ${maxBytes} bytes`);
        }
        hash.update(chunk);
        await fh.write(chunk);
        opts.onProgress?.(received, total);
      }
    } finally {
      await fh.close();
    }
    opts.signal.throwIfAborted();
    if (opts.size !== undefined && received !== opts.size) {
      throw new SetupError('SIZE_MISMATCH', `expected ${opts.size} bytes, got ${received}`);
    }
    const actual = hash.digest('hex');
    if (actual !== opts.sha256.toLowerCase()) {
      throw new SetupError(
        'HASH_MISMATCH',
        `SHA-256 mismatch for ${new URL(opts.url).pathname}: expected ${opts.sha256}, got ${actual}`,
      );
    }
    await rename(part, opts.destPath);
    return { path: opts.destPath, sha256: actual, size: received };
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}
