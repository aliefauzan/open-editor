// Archive extraction with the system bsdtar (handles tar.gz and zip on macOS). The listing is checked
// first, over its full length: no absolute paths, no `..`, only regular files and directories (no
// symlinks, hard links, devices, FIFOs), and a cap on the entry count. Absolute tool path so a
// minimal or Homebrew-free PATH cannot change which tar runs.

import { SetupError, abortError } from './errors.ts';
import { sha256File } from './hash.ts';
import { runCommand, tail } from './run.ts';

const TAR = '/usr/bin/tar';
const MAX_ENTRIES = 20_000;

export type ArchiveFormat = 'tar.gz' | 'zip';

async function list(archive: string, flag: '-tf' | '-tvf', signal: AbortSignal): Promise<string[]> {
  const lines: string[] = [];
  const r = await runCommand(TAR, [flag, archive], {
    signal,
    timeoutMs: 120_000,
    onLine: (l, stream) => {
      if (stream === 'stdout') lines.push(l);
    },
  });
  if (r.code !== 0) {
    throw new SetupError('EXTRACT_FAILED', `cannot read archive: ${tail(r.stderr)}`);
  }
  if (lines.length > MAX_ENTRIES) {
    throw new SetupError('EXTRACT_UNSAFE', `archive has more than ${MAX_ENTRIES} entries`);
  }
  return lines;
}

export async function listArchive(archive: string, signal: AbortSignal): Promise<string[]> {
  const names = await list(archive, '-tf', signal);
  const verbose = await list(archive, '-tvf', signal);
  for (const line of verbose) {
    // bsdtar prints the entry type first: '-' file, 'd' directory, 'l' symlink, 'h' hard link, ...
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new SetupError(
        'EXTRACT_UNSAFE',
        'archive contains an entry that is not a plain file or folder',
      );
    }
  }
  return names;
}

export function assertSafeEntries(entries: string[]): void {
  for (const raw of entries) {
    const parts = raw.split('/');
    if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\0') || parts.includes('..')) {
      throw new SetupError('EXTRACT_UNSAFE', `unsafe archive entry: ${JSON.stringify(raw)}`);
    }
  }
}

export async function extractArchive(opts: {
  archive: string;
  format: ArchiveFormat;
  destDir: string;
  signal: AbortSignal;
  /** Re-checked right before extraction, closing the gap between download and unpack. */
  expectSha256?: string;
}): Promise<void> {
  if (opts.signal.aborted) throw abortError();
  assertSafeEntries(await listArchive(opts.archive, opts.signal));
  if (opts.expectSha256 !== undefined) {
    const actual = await sha256File(opts.archive, opts.signal);
    if (actual !== opts.expectSha256) {
      throw new SetupError('HASH_MISMATCH', 'archive changed on disk after it was verified');
    }
  }
  // bsdtar reads both formats; the listing above has been checked, and bsdtar itself refuses
  // absolute paths and `..` on extraction.
  const r = await runCommand(TAR, ['-xf', opts.archive, '-C', opts.destDir], {
    signal: opts.signal,
    timeoutMs: 300_000,
    captureBytes: 16 * 1024,
  });
  if (r.code !== 0) {
    throw new SetupError('EXTRACT_FAILED', `extract failed: ${tail(r.stderr)}`);
  }
}
