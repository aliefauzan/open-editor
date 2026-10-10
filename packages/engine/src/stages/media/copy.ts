// Safe copy for local ingest (engine spec "Project folder", "Ingest sources"; R4 S2).
// Ingested files and folders are copied, never symlinked. Inside a folder no symlink is followed
// (file or folder, pointing in or out): each one is reported as skipped. The folder the user picked
// is resolved once (it is their explicit choice); everything below it is walked with lstat semantics.
// The copy opens the source with O_NOFOLLOW, re-checks that it lies inside the picked folder, and
// writes a hidden temp beside the destination (O_EXCL | O_NOFOLLOW), moved into place without
// replacing anything (fs/no-replace.ts). So the destination is never overwritten, never written
// through a link, and never half-written: a failed or cancelled copy removes its temp, and a killed
// engine leaves only a `.vox-part-*` temp (phase 04 sweeps them in `media/`).
// A folder walk is bounded: depth, files, and entries seen; unreadable sub-folders are skipped.

import { createHash, randomBytes } from 'node:crypto';
import { constants, type Dir } from 'node:fs';
import { open, opendir, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { VoxError } from '../../errors.ts';
import { EXCL_FLAGS, placeNoReplace } from '../../fs/no-replace.ts';

export interface SkippedEntry {
  path: string;
  reason: 'symlink' | 'special' | 'depth' | 'unreadable';
}

export interface FolderListing {
  /** The picked folder, resolved. */
  root: string;
  /** Regular files, sorted, as absolute paths under `root`. */
  files: string[];
  skipped: SkippedEntry[];
  /** True when `maxFiles` or `maxEntries` stopped the walk. */
  truncated: boolean;
}

export interface ListOptions {
  /** Folder levels below the picked folder that are walked (default 8). */
  maxDepth?: number;
  /** Stop after this many files (default 1000). */
  maxFiles?: number;
  /** Stop after this many directory entries of any kind (default 20000); bounds `skipped` too. */
  maxEntries?: number;
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
  const maxEntries = opts.maxEntries ?? 20_000;
  let seen = 0;
  let filesFull = false;
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
    let handle: Dir;
    try {
      handle = await opendir(folder);
      // A sub-folder swapped for a symlink after its entry was read must not lead out of the tree:
      // the walked path is canonical, so its realpath must not change.
      if (depth > 0 && (await realpath(folder)) !== folder) {
        await handle.close();
        out.skipped.push({ path: folder, reason: 'symlink' });
        return;
      }
    } catch (e) {
      if (depth === 0) {
        throw new VoxError(
          'PATH_INVALID',
          `Cannot read the folder: ${dir}`,
          'Check its permissions.',
          {
            cause: e,
            details: { path: dir },
          },
        );
      }
      out.skipped.push({ path: folder, reason: 'unreadable' });
      return;
    }
    const entries = [];
    for await (const d of handle) {
      if (++seen > maxEntries) {
        out.truncated = true;
        break;
      }
      entries.push(d);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of entries) {
      if (filesFull) return;
      const p = join(folder, d.name);
      // Dirent types come from the directory entry itself (lstat semantics): links stay links.
      if (d.isSymbolicLink()) out.skipped.push({ path: p, reason: 'symlink' });
      else if (d.isDirectory()) {
        if (depth + 1 > maxDepth) out.skipped.push({ path: p, reason: 'depth' });
        else await walk(p, depth + 1);
      } else if (d.isFile()) {
        if (out.files.length >= maxFiles) {
          out.truncated = true;
          filesFull = true;
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
  /** The picked folder: the resolved source must lie inside it (pass it for every folder item). */
  within?: string;
  /** Refuse sources larger than this many bytes, also when one grows during the copy. */
  maxBytes?: number;
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
  const temp = join(
    dirname(dest),
    `.vox-part-${process.pid}-${randomBytes(6).toString('hex')}-${basename(dest).slice(0, 64)}`,
  );
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
      const prefix = base.endsWith(sep) ? base : base + sep;
      const real = await realpath(src);
      const same = await stat(real);
      if (!real.startsWith(prefix) || same.ino !== st.ino || same.dev !== st.dev) {
        throw pathInvalid(`Not copied: "${src}" lies outside the picked folder.`, src);
      }
    }
    const tooBig = (n: number): VoxError =>
      new VoxError(
        'VALIDATION',
        `Not copied: "${src}" is larger than ${String(opts.maxBytes)} bytes.`,
        'Use a smaller file.',
        { details: { path: src, bytes: n, maxBytes: opts.maxBytes } },
      );
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes) throw tooBig(st.size);
    output = await open(temp, EXCL_FLAGS, 0o644);
    created = true;
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
      if (opts.maxBytes !== undefined && bytes > opts.maxBytes) throw tooBig(bytes);
    }
    await output.sync();
    await output.close();
    output = undefined;
    if (opts.signal?.aborted) throw cancelled();
    if (!(await placeNoReplace(temp, dest))) {
      throw pathInvalid(`Not copied: "${dest}" already exists.`, dest);
    }
    created = false;
    return { bytes, sha256: hash.digest('hex') };
  } catch (e) {
    if (output) await output.close().catch(() => undefined);
    if (created) await unlink(temp).catch(() => undefined);
    throw e;
  } finally {
    await input.close();
  }
}
