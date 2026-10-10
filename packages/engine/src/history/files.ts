// Durable file primitives for the write order: fsync'd appends, atomic replace (temp + fsync +
// rename + directory fsync) and a history reader that detects a torn last line.
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

/** Append and fsync. */
export async function appendDurable(path: string, data: string): Promise<void> {
  const fh = await open(path, 'a', 0o600);
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
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  const fh = await open(tmp, 'w', 0o600);
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
  const text = buf.toString('utf8');
  const entries: HistoryEntry[] = [];
  let offset = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    const lineBytes = Buffer.byteLength(line) + (isLast ? 0 : 1);
    if (line.trim() === '') {
      offset += lineBytes;
      continue;
    }
    let parsed: HistoryEntry | undefined;
    try {
      const r = HistoryEntrySchema.safeParse(JSON.parse(line));
      if (r.success) parsed = r.data;
    } catch {
      parsed = undefined;
    }
    // A complete line ends with '\n'; the final unterminated line or a bad final line is torn.
    const lastNonEmpty = lines.slice(i + 1).every((l) => l.trim() === '');
    if (!parsed || (isLast && !text.endsWith('\n'))) {
      if (lastNonEmpty) return { entries, tornAt: offset, size: buf.length };
      throw new HistoryLineError(i + 1, `history.jsonl line ${i + 1} does not parse`);
    }
    entries.push(parsed);
    offset += lineBytes;
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
