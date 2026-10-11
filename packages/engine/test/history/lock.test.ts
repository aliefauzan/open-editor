import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { acquireLock } from '../../src/history/lock.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'vox-lock-'));
const lockFile = (d: string) => join(d, 'project.lock');

describe('project.lock (O_EXCL)', () => {
  test('writes { pid, host, startedAt } and release removes it', async () => {
    const d = dir();
    const release = await acquireLock(d);
    const info = JSON.parse(readFileSync(lockFile(d), 'utf8'));
    expect(info).toMatchObject({ pid: process.pid, host: hostname() });
    expect(typeof info.startedAt).toBe('string');
    await release();
    expect(existsSync(lockFile(d))).toBe(false);
  });
  test('a live lock of this host makes the second taker wait, then LOCKED', async () => {
    const d = dir();
    const release = await acquireLock(d);
    const t0 = Date.now();
    await expect(acquireLock(d, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'LOCKED' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    await release();
  });
  test('a waiting taker gets the lock once it is released', async () => {
    const d = dir();
    const release = await acquireLock(d);
    const second = acquireLock(d, { timeoutMs: 2000 });
    setTimeout(() => void release(), 100);
    const r2 = await second;
    await r2();
  });
  test('a dead pid on this host is broken', async () => {
    const d = dir();
    writeFileSync(
      lockFile(d),
      JSON.stringify({ pid: 999_999_9, host: hostname(), startedAt: new Date().toISOString() }),
    );
    const release = await acquireLock(d, { timeoutMs: 200, isPidAlive: () => false });
    await release();
  });
  test('a lock older than 60 s on this host is broken even if the pid lives', async () => {
    const d = dir();
    writeFileSync(
      lockFile(d),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: new Date(Date.now() - 61_000).toISOString(),
      }),
    );
    const old = new Date(Date.now() - 61_000);
    utimesSync(lockFile(d), old, old);
    const release = await acquireLock(d, { timeoutMs: 200 });
    await release();
  });
  test('a lock from another host is never broken: LOCKED after the wait', async () => {
    const d = dir();
    writeFileSync(
      lockFile(d),
      JSON.stringify({
        pid: 1,
        host: 'other-host.example',
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );
    await expect(acquireLock(d, { timeoutMs: 300, isPidAlive: () => false })).rejects.toMatchObject(
      { code: 'LOCKED' },
    );
    expect(existsSync(lockFile(d))).toBe(true);
  });
  test('the default wait is 5 s', async () => {
    const d = dir();
    writeFileSync(
      lockFile(d),
      JSON.stringify({ pid: 1, host: 'other-host.example', startedAt: new Date().toISOString() }),
    );
    const t0 = Date.now();
    await expect(acquireLock(d)).rejects.toMatchObject({ code: 'LOCKED' });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThan(7000);
  }, 10_000);
  test('an unreadable (torn) lock file of a crashed writer is treated as stale after 60 s only', async () => {
    const d = dir();
    writeFileSync(lockFile(d), '{"pid": 12');
    await expect(acquireLock(d, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'LOCKED' });
    const old = new Date(Date.now() - 61_000);
    utimesSync(lockFile(d), old, old);
    const release = await acquireLock(d, { timeoutMs: 200 });
    await release();
  });

  test('takers breaking the same dead lock at once: exactly one gets it', async () => {
    for (let round = 0; round < 20; round++) {
      const d = dir();
      writeFileSync(
        lockFile(d),
        JSON.stringify({ pid: 9_999_999, host: hostname(), startedAt: new Date().toISOString() }),
      );
      const takers = Array.from({ length: 4 }, () =>
        acquireLock(d, { timeoutMs: 300, isPidAlive: (pid) => pid === process.pid }),
      );
      const settled = await Promise.allSettled(takers);
      const won = settled.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
      expect(readdirSync(d)).toEqual([]);
    }
  });

  test('a break marker of a crashed taker blocks breaking for 10 s only', async () => {
    const d = dir();
    const dead = JSON.stringify({
      pid: 9_999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    writeFileSync(lockFile(d), dead);
    writeFileSync(join(d, '.project.lock.break'), '');
    const alive = (pid: number) => pid === process.pid;
    await expect(acquireLock(d, { timeoutMs: 200, isPidAlive: alive })).rejects.toMatchObject({
      code: 'LOCKED',
    });
    const old = new Date(Date.now() - 11_000);
    utimesSync(join(d, '.project.lock.break'), old, old);
    const release = await acquireLock(d, { timeoutMs: 200, isPidAlive: alive });
    await release();
    expect(readdirSync(d)).toEqual([]);
  });
});
