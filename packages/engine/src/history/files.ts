// Durable file primitives for the write order: fsync'd appends, atomic replace (temp + fsync +
// rename + directory fsync) and a history reader that detects a torn last line.
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, truncate, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HistoryEntrySchema, type HistoryEntry } from './types.ts';

export async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Append and fsync. A symlink in place of the file is refused (O_NOFOLLOW). */
export async function appendDurable(path: string, data: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const fh = await open(path, flags, 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Write to a temp file, fsync it, rename over `path`, fsync the directory. */
export async function writeAtomic(
  path: string,
  data: string | Uint8Array,
  hooks?: { afterTemp?: () => void },
): Promise<void> {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    hooks?.afterTemp?.();
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fsyncDir(dirname(path));
}

export interface HistoryRead {
  entries: HistoryEntry[];
  /** Byte length of the parseable part when the last line is torn. */
  tornAt?: number;
  /** Bytes in the file. */
  size: number;
}

export class HistoryLineError extends Error {
  readonly lineNo: number;
  constructor(lineNo: number, message: string) {
    super(message);
    this.lineNo = lineNo;
  }
}

/** Parse history.jsonl. A last line that does not parse is reported as torn; any other bad line throws. */
export async function readHistory(path: string): Promise<HistoryRead> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], size: 0 };
    throw e;
  }
  // Split on the byte 0x0A so offsets are byte offsets (truncation point of a torn line).
  const lines: { start: number; text: string; terminated: boolean }[] = [];
  for (let start = 0; start < buf.length;) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    lines.push({ start, text: buf.toString('utf8', start, end), terminated: nl !== -1 });
    start = end + 1;
  }
  let lastNonBlank = -1;
  lines.forEach((l, i) => {
    if (l.text.trim() !== '') lastNonBlank = i;
  });
  const entries: HistoryEntry[] = [];
  for (let i = 0; i <= lastNonBlank; i++) {
    const l = lines[i]!;
    if (l.text.trim() === '') continue;
    let parsed: HistoryEntry | undefined;
    try {
      const r = HistoryEntrySchema.safeParse(JSON.parse(l.text));
      if (r.success) parsed = r.data;
    } catch {
      parsed = undefined;
    }
    // A complete line ends with '\n'; the final unterminated line or a bad final line is torn.
    if (!parsed || !l.terminated) {
      if (i === lastNonBlank) return { entries, tornAt: l.start, size: buf.length };
      throw new HistoryLineError(i + 1, `history.jsonl line ${i + 1} does not parse`);
    }
    entries.push(parsed);
  }
  return { entries, size: buf.length };
}

export async function truncateTo(path: string, bytes: number): Promise<void> {
  await truncate(path, bytes);
  const fh = await open(path, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
