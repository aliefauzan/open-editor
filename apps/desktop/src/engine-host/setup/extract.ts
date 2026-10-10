// Archive extraction with the system bsdtar (handles tar.gz and zip on macOS). The listing is checked
// first: no absolute paths, no `..`, no symlinks or hard links. Absolute tool path so a minimal or
// Homebrew-free PATH cannot change which tar runs.

import { SetupError, abortError } from './errors.ts';
import { runCommand, tail } from './run.ts';

const TAR = '/usr/bin/tar';

export type ArchiveFormat = 'tar.gz' | 'zip';

export async function listArchive(archive: string, signal: AbortSignal): Promise<string[]> {
  const plain = await runCommand(TAR, ['-tf', archive], { signal, timeoutMs: 120_000 });
  if (plain.code !== 0) {
    throw new SetupError('EXTRACT_FAILED', `cannot read archive: ${tail(plain.stderr)}`);
  }
  const verbose = await runCommand(TAR, ['-tvf', archive], { signal, timeoutMs: 120_000 });
  if (verbose.code !== 0) {
    throw new SetupError('EXTRACT_FAILED', `cannot read archive: ${tail(verbose.stderr)}`);
  }
  for (const line of verbose.stdout.split('\n')) {
    const type = line[0];
    if (type === 'l' || type === 'h') {
      throw new SetupError('EXTRACT_UNSAFE', 'archive contains a link entry');
    }
  }
  return plain.stdout.split('\n').filter((l) => l !== '');
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
}): Promise<void> {
  if (opts.signal.aborted) throw abortError();
  assertSafeEntries(await listArchive(opts.archive, opts.signal));
  // bsdtar reads both formats; -x never follows absolute paths here because the listing is checked.
  const r = await runCommand(TAR, ['-xf', opts.archive, '-C', opts.destDir], {
    signal: opts.signal,
    timeoutMs: 300_000,
  });
  if (r.code !== 0) {
    throw new SetupError('EXTRACT_FAILED', `extract failed: ${tail(r.stderr)}`);
  }
}
