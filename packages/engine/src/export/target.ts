// Export targets (engine spec "Export targets", D-13; R3 "Files and paths"; R4 S32).
// An export goes to `{ file }`, `{ dir }` or, without a target, the project's `renders/`. The file
// is written as a hidden temp file in the final folder, then moved into place, so a failed or
// cancelled export never leaves a half file. An existing file is never replaced silently:
// `{ file }` needs `overwrite`; `{ dir }` adds ` (2)`, ` (3)` …; `renders/` adds `-2`, `-3` ….
// The no-replace move is atomic (`link` + `unlink`), so a file that appears meanwhile is kept.
// Temps left by a killed engine process are swept by the next export into the same folder.
// Only trusted callers (CLI, the app's engine host) pass a target; the agent has none (spec 3).

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { VoxError } from '../errors.pending.ts';

export type ExportTarget = { file: string } | { dir: string };

export interface ExportOptions {
  /** Where the user wants it; omitted → `defaultDir`. */
  target?: ExportTarget | undefined;
  /** The project's `renders/` folder (created when needed). */
  defaultDir: string;
  /** Engine-generated name without extension, e.g. `<project>-<sequence>`; passed through safeStem. */
  stem: string;
  /** Extension without the dot: `mp4`, `srt`, `vtt`, `otio` … */
  ext: string;
  /** `{ file }` only: replace an existing file (CLI `--overwrite`, or the app's save dialog). */
  overwrite?: boolean | undefined;
}

export interface PreparedExport {
  /** Write the export here (it exists, empty). */
  tempPath: string;
  /** Where commit() will put it unless the name is taken meanwhile (folder modes move on). */
  finalPath: string;
  /** fsync + move into place; returns the written path. Removes the temp on failure. */
  commit(): Promise<string>;
  /** Remove the temp file (idempotent). */
  discard(): Promise<void>;
}

type Mode = 'file' | 'dir' | 'renders';

const MAX_SUFFIX = 9999;
const TEMP_RE = /^\..*\.vox-tmp-(\d+)-[0-9a-f]+(\.[^.]*)?$/;

function exportPath(
  message: string,
  hint: string,
  details: Record<string, unknown> = {},
  cause?: unknown,
): VoxError {
  return new VoxError(
    'EXPORT_PATH',
    message,
    hint,
    cause === undefined ? { details } : { details, cause },
  );
}

const CHOOSE = 'Choose an existing folder you can write to (an absolute path).';

/** A file-name stem from a project/sequence name: no separators, control characters or leading dots. */
export function safeStem(name: string): string {
  let s = name
    .replace(/[/\\:]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  s = Array.from(s).slice(0, 120).join('');
  return s.length === 0 ? 'export' : s;
}

function checkAbs(p: unknown, what: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0') || !isAbsolute(p)) {
    throw exportPath(`The export ${what} must be an absolute path: ${JSON.stringify(p)}.`, CHOOSE, {
      path: p,
    });
  }
  return p;
}

async function checkFolder(dir: string): Promise<void> {
  let st;
  try {
    st = await stat(dir);
  } catch (e) {
    throw exportPath(`The export folder does not exist: ${dir}`, CHOOSE, { path: dir }, e);
  }
  if (!st.isDirectory())
    throw exportPath(`The export folder is not a folder: ${dir}`, CHOOSE, { path: dir });
  try {
    await access(dir, constants.W_OK);
  } catch (e) {
    throw exportPath(`The export folder is not writable: ${dir}`, CHOOSE, { path: dir }, e);
  }
}

const exists = async (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Remove export temps in `dir` whose owning process is gone. */
export async function sweepStaleTemps(dir: string): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const n of names) {
    const m = TEMP_RE.exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pidAlive(pid)) continue;
    const p = join(dir, n);
    try {
      if ((await lstat(p)).isFile()) {
        await unlink(p);
        removed.push(p);
      }
    } catch {
      // raced with someone else; fine
    }
  }
  return removed;
}

function candidate(mode: Mode, stem: string, ext: string, n: number): string {
  if (n === 1) return `${stem}.${ext}`;
  return mode === 'dir' ? `${stem} (${n}).${ext}` : `${stem}-${n}.${ext}`;
}

async function freeName(
  dir: string,
  mode: Mode,
  stem: string,
  ext: string,
  from: number,
): Promise<{ name: string; n: number }> {
  for (let n = from; n <= MAX_SUFFIX; n++) {
    const name = candidate(mode, stem, ext, n);
    if (!(await exists(join(dir, name)))) return { name, n };
  }
  throw exportPath(
    `Too many exports named "${stem}" in ${dir}.`,
    'Choose another folder or file name.',
    { path: dir },
  );
}

async function fsyncPath(p: string, flags: number): Promise<void> {
  const fh = await open(p, flags);
  try {
    await fh.sync();
  } catch {
    // some file systems do not support fsync on folders
  } finally {
    await fh.close();
  }
}

/** Validate the target, pick the final name and create the temp file beside it. */
export async function prepareExport(o: ExportOptions): Promise<PreparedExport> {
  const ext = o.ext.replace(/^\./, '');
  if (!/^[A-Za-z0-9]{1,8}$/.test(ext))
    throw new VoxError(
      'VALIDATION',
      `Bad export extension "${o.ext}".`,
      'This is an engine bug; please report it.',
    );
  const stem = safeStem(o.stem);
  const t = o.target as Record<string, unknown> | undefined;
  let mode: Mode;
  let folder: string;
  let fileName = '';
  if (t === undefined) {
    mode = 'renders';
    folder = checkAbs(o.defaultDir, 'folder');
    await mkdir(folder, { recursive: true });
    await checkFolder(folder);
  } else {
    const hasFile = 'file' in t && t['file'] !== undefined;
    const hasDir = 'dir' in t && t['dir'] !== undefined;
    if (hasFile === hasDir)
      throw exportPath('An export target is either { file } or { dir }.', CHOOSE, { target: t });
    if (hasFile) {
      mode = 'file';
      const file = checkAbs(t['file'], 'file');
      folder = dirname(file);
      fileName = basename(file);
      await checkFolder(folder);
      const st = await lstat(file).catch(() => undefined);
      if (st?.isDirectory())
        throw exportPath(
          `The export file is a folder: ${file}`,
          'Choose a file name, not a folder.',
          { path: file },
        );
      if (st && !o.overwrite) {
        throw exportPath(
          `The file already exists: ${file}`,
          'Pass --overwrite to replace it, or choose another name.',
          { path: file },
        );
      }
    } else {
      mode = 'dir';
      folder = checkAbs(t['dir'], 'folder');
      await checkFolder(folder);
    }
  }
  await sweepStaleTemps(folder);

  let n = 1;
  if (mode !== 'file') {
    const free = await freeName(folder, mode, stem, ext, 1);
    fileName = free.name;
    n = free.n;
  }
  const tempPath = join(
    folder,
    `.${fileName}.vox-tmp-${process.pid}-${randomBytes(6).toString('hex')}.${ext}`,
  );
  try {
    await (
      await open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      )
    ).close();
  } catch (e) {
    throw exportPath(`Cannot write in the export folder: ${folder}`, CHOOSE, { path: folder }, e);
  }

  let finalPath = join(folder, fileName);
  let done = false;
  const discard = async (): Promise<void> => {
    await unlink(tempPath).catch(() => undefined);
  };

  const commit = async (): Promise<string> => {
    if (done) return finalPath;
    try {
      await fsyncPath(tempPath, constants.O_RDONLY);
      if (mode === 'file' && o.overwrite) {
        await rename(tempPath, finalPath);
      } else {
        for (;;) {
          let placed = false;
          try {
            await link(tempPath, finalPath); // fails with EEXIST: never replaces
            placed = true;
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') {
              // No hard links on this volume (exFAT, some network shares): check, then rename.
              if (!(await exists(finalPath))) {
                await rename(tempPath, finalPath);
                break;
              }
            }
          }
          if (placed) {
            await unlink(tempPath);
            break;
          }
          if (mode === 'file') {
            throw exportPath(
              `The file already exists: ${finalPath}`,
              'Pass --overwrite to replace it, or choose another name.',
              {
                path: finalPath,
              },
            );
          }
          const free = await freeName(folder, mode, stem, ext, n + 1);
          n = free.n;
          finalPath = join(folder, free.name);
        }
      }
      await fsyncPath(folder, constants.O_RDONLY).catch(() => undefined);
      done = true;
      return finalPath;
    } catch (e) {
      await discard();
      throw e;
    }
  };

  return {
    tempPath,
    get finalPath() {
      return finalPath;
    },
    commit,
    discard,
  };
}

/**
 * Prepare, let `produce` write the temp file, then commit. Any failure or cancel removes the temp
 * and rethrows (`CANCELLED` when `signal` fired), so the target folder never holds a half file.
 */
export async function writeExport(
  o: ExportOptions,
  produce: (tempPath: string) => Promise<void>,
  run: { signal?: AbortSignal } = {},
): Promise<string> {
  const cancelled = (): VoxError =>
    new VoxError(
      'CANCELLED',
      'The export was cancelled.',
      'Nothing was written; export again when ready.',
    );
  if (run.signal?.aborted) throw cancelled();
  const p = await prepareExport(o);
  try {
    await produce(p.tempPath);
    if (run.signal?.aborted) throw cancelled();
  } catch (e) {
    await p.discard();
    throw e;
  }
  return p.commit();
}
