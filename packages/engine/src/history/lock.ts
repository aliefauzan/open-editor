// Cross-process write lock (engine spec "Write order, crash recovery, locking"): `project.lock`
// created with O_EXCL holding { pid, host, startedAt }. A lock of this host whose pid is dead, or
// that is older than 60 s, is broken; a lock of another host never is (LOCKED after the wait).
import { open, readFile, stat, unlink } from 'node:fs/promises';
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
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(
  path: string,
): Promise<{ info?: LockInfo; raw: string; mtimeMs: number } | undefined> {
  try {
    const [raw, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    let info: LockInfo | undefined;
    try {
      const v = JSON.parse(raw) as Partial<LockInfo>;
      if (
        typeof v.pid === 'number' &&
        typeof v.host === 'string' &&
        typeof v.startedAt === 'string'
      ) {
        info = v as LockInfo;
      }
    } catch {
      info = undefined;
    }
    return info ? { info, raw, mtimeMs: st.mtimeMs } : { raw, mtimeMs: st.mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Take the lock of a project folder; resolves to a release function. */
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
  const mine: LockInfo = { pid: process.pid, host, startedAt: new Date().toISOString() };
  const mineRaw = JSON.stringify(mine);
  let holder: LockInfo | undefined;
  for (;;) {
    try {
      const fh = await open(path, 'wx', 0o600);
      try {
        await fh.writeFile(mineRaw);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return async () => {
        const cur = await readLock(path);
        if (cur?.raw === mineRaw) await unlink(path).catch(() => undefined);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const cur = await readLock(path);
    if (cur) {
      holder = cur.info;
      const startedMs = cur.info ? Date.parse(cur.info.startedAt) : NaN;
      const ageMs = Date.now() - Math.max(cur.mtimeMs, Number.isNaN(startedMs) ? 0 : startedMs);
      const sameHost = cur.info ? cur.info.host === host : true;
      const dead = cur.info !== undefined && sameHost && !alive(cur.info.pid);
      if (sameHost && (dead || ageMs > staleMs)) {
        const again = await readLock(path);
        if (again?.raw === cur.raw) await unlink(path).catch(() => undefined);
        continue;
      }
    } else continue;
    if (Date.now() >= deadline) {
      throw new VoxError(
        'LOCKED',
        `The project is locked by ${holder ? `pid ${holder.pid} on ${holder.host}` : 'another writer'}`,
        holder && holder.host !== host
          ? 'Another computer holds the lock; if it is gone, run `vox doctor <project> --unlock`'
          : 'Another Vox process is writing this project; try again in a moment',
        { details: holder ? { holder } : {} },
      );
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}
