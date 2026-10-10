// Safe copy for local ingest (engine spec "Project folder", "Ingest sources"; R4 S2).
// Ingested files and folders are copied, never symlinked. Inside a folder no symlink is followed
// (file or folder, pointing in or out): each one is reported as skipped. The folder the user picked
// is resolved once (it is their explicit choice); everything below it is walked with lstat semantics.
// The copy opens the source with O_NOFOLLOW, re-checks that it lies inside the picked folder, and
// creates the destination exclusively (O_EXCL | O_NOFOLLOW), so it never overwrites or writes
// through a link. A failed or cancelled copy removes its partial destination.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { VoxError } from '../../errors.pending.ts';

export interface SkippedEntry {
  path: string;
  reason: 'symlink' | 'special' | 'depth';
}

export interface FolderListing {
  /** The picked folder, resolved. */
  root: string;
  /** Regular files, sorted, as absolute paths under `root`. */
  files: string[];
  skipped: SkippedEntry[];
  /** True when `maxFiles` stopped the walk. */
  truncated: boolean;
}

export interface ListOptions {
  /** Folder levels below the picked folder that are walked (default 8). */
  maxDepth?: number;
  /** Stop after this many files (default 1000). */
  maxFiles?: number;
}

function pathInvalid(message: string, path: string): VoxError {
  return new VoxError(
    'PATH_INVALID',
    message,
    'Pick the original file, not a link or a special file.',
    {
      details: { path },
    },
  );
}

const cancelled = (): VoxError =>
  new VoxError(
    'CANCELLED',
    'The copy was cancelled.',
    'Nothing was copied; run it again when ready.',
  );

/** Regular files in a picked folder, without following any symlink below it. */
export async function listFolderFiles(dir: string, opts: ListOptions = {}): Promise<FolderListing> {
  const maxDepth = opts.maxDepth ?? 8;
  const maxFiles = opts.maxFiles ?? 1000;
  let root: string;
  try {
    root = await realpath(dir);
  } catch (e) {
    throw new VoxError('NOT_FOUND', `Folder not found: ${dir}`, 'Check the path and try again.', {
      cause: e,
    });
  }
  if (!(await stat(root)).isDirectory()) {
    throw new VoxError(
      'VALIDATION',
      `Not a folder: ${dir}`,
      'Pass a folder, or add the file on its own.',
    );
  }
  const out: FolderListing = { root, files: [], skipped: [], truncated: false };

  const walk = async (folder: string, depth: number): Promise<void> => {
    const entries = [];
    for await (const d of await opendir(folder)) entries.push(d);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      if (out.truncated) return;
      const p = join(folder, d.name);
      // Dirent types come from the directory entry itself (lstat semantics): links stay links.
      if (d.isSymbolicLink()) out.skipped.push({ path: p, reason: 'symlink' });
      else if (d.isDirectory()) {
        if (depth + 1 > maxDepth) out.skipped.push({ path: p, reason: 'depth' });
        else await walk(p, depth + 1);
      } else if (d.isFile()) {
        if (out.files.length >= maxFiles) {
          out.truncated = true;
          return;
        }
        out.files.push(p);
      } else out.skipped.push({ path: p, reason: 'special' });
    }
  };
  await walk(root, 0);
  return out;
}

export interface CopyOptions {
  signal?: AbortSignal;
  /** The picked folder: the resolved source must lie inside it. */
  within?: string;
}

export interface CopyResult {
  bytes: number;
  /** SHA-256 of the copied bytes (ingest's cache key). */
  sha256: string;
}

const CHUNK = 1024 * 1024;

/** Copy one regular file to a new destination (never replaced), hashing it on the way. */
export async function copyFileSafe(
  src: string,
  dest: string,
  opts: CopyOptions = {},
): Promise<CopyResult> {
  if (opts.signal?.aborted) throw cancelled();
  let input: FileHandle;
  try {
    input = await open(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK')
      throw pathInvalid(`Not copied: "${src}" is a symlink.`, src);
    throw new VoxError(
      'NOT_FOUND',
      `Cannot read "${src}" (${code ?? 'error'}).`,
      'Check the path and try again.',
      {
        cause: e,
      },
    );
  }
  let output: FileHandle | undefined;
  let created = false;
  try {
    const st = await input.stat();
    if (!st.isFile()) throw pathInvalid(`Not copied: "${src}" is not a regular file.`, src);
    if (opts.within !== undefined) {
      const base = await realpath(opts.within);
      const real = await realpath(src);
      const same = await stat(real);
      if (!real.startsWith(base + sep) || same.ino !== st.ino || same.dev !== st.dev) {
        throw pathInvalid(`Not copied: "${src}" lies outside the picked folder.`, src);
      }
    }
    try {
      output = await open(
        dest,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      created = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ELOOP')
        throw pathInvalid(`Not copied: "${dest}" already exists.`, dest);
      throw e;
    }
    const hash = createHash('sha256');
    const buf = Buffer.alloc(CHUNK);
    let bytes = 0;
    for (;;) {
      if (opts.signal?.aborted) throw cancelled();
      const { bytesRead } = await input.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      hash.update(chunk);
      let off = 0;
      while (off < bytesRead) off += (await output.write(chunk, off, bytesRead - off)).bytesWritten;
      bytes += bytesRead;
    }
    await output.sync();
    await output.close();
    output = undefined;
    return { bytes, sha256: hash.digest('hex') };
  } catch (e) {
    if (output) await output.close().catch(() => undefined);
    if (created) await unlink(dest).catch(() => undefined);
    throw e;
  } finally {
    await input.close();
  }
}
