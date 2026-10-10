// C12 / engine done-when #6: killing a writer mid-write never loses or corrupts a project.
// A child process SIGKILLs itself at each write step, and a randomized loop kills `vox op`-style
// writers at random moments; every reopen must load, with project.json at the last history version.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ProjectStore } from '../../src/history/store.ts';
import { newStore, readEntries } from '../helpers/store.ts';

const child = fileURLToPath(new URL('./fixtures/kill-child.ts', import.meta.url));

function runChild(dir: string, step: string, count: number) {
  return spawnSync(process.execPath, [child, dir, step, String(count)], { encoding: 'utf8' });
}

async function checkConsistent(dir: string): Promise<number> {
  const store = await ProjectStore.open(dir);
  const entries = readEntries(dir);
  const last = entries.at(-1)?.version ?? 0;
  expect(store.project.version).toBe(last);
  if (last > 0) expect(store.project.sequences[0]!.name).toBe(`k${last}`);
  return last;
}

describe('kill tests', () => {
  test.each(['history-appended', 'temp-written', 'renamed'])(
    'SIGKILL at %s: the reopened project is at the history version and writable',
    async (step) => {
      const { dir, store } = await newStore();
      await store.apply(
        { op: 'updateSequence', args: { sequenceId: 'seq_1', name: 'k1' } },
        { actor: 'cli' },
      );
      const r = runChild(dir, step, 1);
      expect(r.signal).toBe('SIGKILL');
      expect(existsSync(join(dir, 'project.lock'))).toBe(true); // left behind by the dead writer
      expect(await checkConsistent(dir)).toBe(2);
      const again = await ProjectStore.open(dir);
      const res = await again.apply(
        { op: 'updateSequence', args: { sequenceId: 'seq_1', name: 'k3' } },
        { actor: 'cli' },
      );
      expect(res.version).toBe(3); // the dead pid's lock was broken
      expect(await checkConsistent(dir)).toBe(3);
    },
    30_000,
  );

  test('randomized: 15 writers killed at random moments never lose or corrupt the project', async () => {
    const { dir } = await newStore();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let prev = 0;
    for (let i = 0; i < 15; i++) {
      const p = spawn(process.execPath, [child, dir, 'none', '100000'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve) => p.stdout.once('data', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 30 + Math.floor(rnd() * 150)));
      p.kill('SIGKILL');
      await new Promise((resolve) => p.once('exit', resolve));
      const v = await checkConsistent(dir);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBeGreaterThan(15);
  }, 120_000);
});
