// Cross-process write lock (engine spec "Write order, crash recovery, locking"): `project.lock`
// created exclusively (a hard link of a fully written temp file, as atomic as O_EXCL) holding
// { pid, host, startedAt, nonce }. A lock of this host whose pid is dead, or that is older than
// 60 s, is broken; a lock of another host never is (LOCKED after the wait).
import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VoxError } from '../errors.ts';

export const LOCK_FILE = 'project.lock';

export interface LockOptions {
  /** How long to wait for a held lock (default 5 s). */
  timeoutMs?: number;
  /** Age after which a lock of this host is broken (default 60 s). */
  staleMs?: number;
  host?: string;
  isPidAlive?: (pid: number) => boolean;
}

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  /** Random per acquisition, so a release or a stale-lock break never removes another taker's lock. */
  nonce?: string;
}

/** Prefix of the lock's temp and set-aside files (`.project.lock.<nonce>`). */
export const LOCK_TEMP_PREFIX = `.${LOCK_FILE}.`;

/** Only ESRCH means the process is gone; EPERM (another user's process) counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseInfo(raw: string): LockInfo | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo> | null;
    if (
      v &&
      typeof v.pid === 'number' &&
      Number.isInteger(v.pid) &&
      v.pid > 0 &&
      typeof v.host === 'string' &&
      typeof v.startedAt === 'string'
    ) {
      return v as LockInfo;
    }
  } catch {
    // torn or foreign content
  }
  return undefined;
}

async function readLock(
  path: string,
): Promise<{ info?: LockInfo; raw: string; mtimeMs: number } | undefined> {
  try {
    const [raw, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const info = parseInfo(raw);
    return info ? { info, raw, mtimeMs: st.mtimeMs } : { raw, mtimeMs: st.mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function writeSynced(path: string, data: string): Promise<void> {
  const fh = await open(path, 'wx', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Take the lock of a project folder; resolves to a release function. The lock content is written
 * to a temp file first and hard-linked into place (link fails with EEXIST like O_EXCL), so a
 * writer killed at any moment never leaves an empty or torn `project.lock`.
 */
export async function acquireLock(
  dir: string,
  opts: LockOptions = {},
): Promise<() => Promise<void>> {
  const path = join(dir, LOCK_FILE);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 60_000;
  const host = opts.host ?? hostname();
  const alive = opts.isPidAlive ?? pidAlive;
  const deadline = Date.now() + timeoutMs;
  const nonce = randomBytes(8).toString('hex');
  const mine: LockInfo = { pid: process.pid, host, startedAt: new Date().toISOString(), nonce };
  const mineRaw = JSON.stringify(mine);
  const tmp = join(dir, `${LOCK_TEMP_PREFIX}${nonce}`);
  const aside = join(dir, `${LOCK_TEMP_PREFIX}stale-${nonce}`);
  await writeSynced(tmp, mineRaw);
  let holder: LockInfo | undefined;
  try {
    for (let first = true; ; first = false) {
      if (!first && Date.now() >= deadline) {
        throw new VoxError(
          'LOCKED',
          `The project is locked by ${holder ? `pid ${holder.pid} on ${holder.host}` : 'another writer'}`,
          holder && holder.host !== host
            ? 'Another computer holds the lock; if it is gone, run `vox doctor <project> --unlock`'
            : 'Another Vox process is writing this project; try again in a moment',
          { details: holder ? { holder } : {} },
        );
      }
      try {
        await link(tmp, path);
        return async () => {
          const cur = await readLock(path);
          if (cur?.raw === mineRaw) await unlink(path).catch(() => undefined);
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const cur = await readLock(path);
      if (!cur) continue;
      holder = cur.info;
      const startedMs = cur.info ? Date.parse(cur.info.startedAt) : NaN;
      const ageMs = Date.now() - Math.max(cur.mtimeMs, Number.isNaN(startedMs) ? 0 : startedMs);
      const sameHost = cur.info ? cur.info.host === host : true;
      const dead = cur.info !== undefined && sameHost && !alive(cur.info.pid);
      if (sameHost && (dead || ageMs > staleMs)) {
        await breakStale(path, aside, cur.raw);
        continue;
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Break a stale lock by moving it aside first: only the taker whose rename moved the stale content
 * deletes it. If the rename moved a fresh lock instead (another taker won in between), it is put
 * back unless a third taker already holds the name.
 */
async function breakStale(path: string, aside: string, staleRaw: string): Promise<void> {
  try {
    await rename(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const moved = await readFile(aside, 'utf8').catch(() => undefined);
  if (moved !== staleRaw) await link(aside, path).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
}
