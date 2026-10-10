// S2: ingested folders are copied, never symlinked; a symlink pointing out of the folder is not
// followed. Folder trees with hostile links are built in a temp folder by the test.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { copyFileSafe, listFolderFiles } from '../../src/stages/media/copy.ts';
import { codeOfAsync, removeDir, tempDir } from './helpers.ts';

const dirs: string[] = [];
let root = '';
let src = '';
let outside = '';
let dest = '';

beforeEach(() => {
  root = tempDir('vox-copy-');
  dirs.push(root);
  src = join(root, 'drop');
  outside = join(root, 'outside');
  dest = join(root, 'project', 'media');
  mkdirSync(join(src, 'sub', 'deeper'), { recursive: true });
  mkdirSync(outside);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(src, 'a.mp4'), 'A');
  writeFileSync(join(src, 'sub', 'b.wav'), 'BB');
  writeFileSync(join(src, 'sub', 'deeper', 'c.png'), 'CCC');
  writeFileSync(join(outside, 'secret.txt'), 'private');
  mkdirSync(join(outside, 'dir'));
  writeFileSync(join(outside, 'dir', 'x.mp4'), 'X');
  // Hostile links: a file link out, a folder link out, a link loop, a dangling link, a link inside.
  symlinkSync(join(outside, 'secret.txt'), join(src, 'evil.mp4'));
  symlinkSync(join(outside, 'dir'), join(src, 'linkdir'));
  symlinkSync('../..', join(src, 'sub', 'loop'));
  symlinkSync(join(root, 'nope'), join(src, 'dangling.mp4'));
  symlinkSync('a.mp4', join(src, 'inside-link.mp4'));
});

afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

describe('listFolderFiles (S2)', () => {
  test('lists regular files only; no symlink is followed, each one is reported as skipped', async () => {
    const r = await listFolderFiles(src);
    expect(r.files.map((f) => f.slice(src.length + 1)).sort()).toEqual([
      'a.mp4',
      'sub/b.wav',
      'sub/deeper/c.png',
    ]);
    expect(r.skipped.map((s) => [s.path.slice(src.length + 1), s.reason]).sort()).toEqual([
      ['dangling.mp4', 'symlink'],
      ['evil.mp4', 'symlink'],
      ['inside-link.mp4', 'symlink'],
      ['linkdir', 'symlink'],
      ['sub/loop', 'symlink'],
    ]);
    expect(r.files.some((f) => f.includes('outside') || f.includes('secret'))).toBe(false);
  });

  test('special files (FIFO) are skipped, not opened', async () => {
    let made = true;
    try {
      execFileSync('mkfifo', [join(src, 'pipe.mp4')]);
    } catch {
      made = false;
    }
    if (!made) return;
    const r = await listFolderFiles(src);
    expect(r.skipped).toContainEqual({ path: join(src, 'pipe.mp4'), reason: 'special' });
    expect(r.files).not.toContain(join(src, 'pipe.mp4'));
  });

  test('limits: depth and file count are reported, not silently dropped', async () => {
    const shallow = await listFolderFiles(src, { maxDepth: 1 });
    expect(shallow.files.map((f) => f.slice(src.length + 1)).sort()).toEqual([
      'a.mp4',
      'sub/b.wav',
    ]);
    expect(shallow.skipped).toContainEqual({ path: join(src, 'sub', 'deeper'), reason: 'depth' });
    const few = await listFolderFiles(src, { maxFiles: 2 });
    expect(few.files).toHaveLength(2);
    expect(few.truncated).toBe(true);
  });

  test('the folder itself must be a folder', async () => {
    expect(await codeOfAsync(listFolderFiles(join(src, 'a.mp4')))).toBe('VALIDATION');
    expect(await codeOfAsync(listFolderFiles(join(root, 'missing')))).toBe('NOT_FOUND');
  });

  test('a symlinked top-level folder given by the user is resolved once (explicit choice)', async () => {
    symlinkSync(src, join(root, 'drop-link'));
    const r = await listFolderFiles(join(root, 'drop-link'));
    expect(r.files).toHaveLength(3);
    expect(r.files.every((f) => f.startsWith(src + '/'))).toBe(true);
  });
});

describe('copyFileSafe (S2)', () => {
  test('folder ingest copy: every listed file becomes a regular file in media/, no link anywhere', async () => {
    const { files } = await listFolderFiles(src);
    let i = 0;
    for (const f of files) {
      const r = await copyFileSafe(f, join(dest, `m_${i++}.bin`), { within: src });
      expect(r.sha256).toBe(createHash('sha256').update(readFileSync(f)).digest('hex'));
      expect(r.bytes).toBe(statSync(f).size);
    }
    const out = readdirSync(dest);
    expect(out).toHaveLength(3);
    for (const name of out) expect(lstatSync(join(dest, name)).isFile()).toBe(true);
    expect(out.map((n) => readFileSync(join(dest, n), 'utf8')).sort()).toEqual(['A', 'BB', 'CCC']);
  });

  test('a symlink source is refused (O_NOFOLLOW), even when called directly', async () => {
    expect(await codeOfAsync(copyFileSafe(join(src, 'evil.mp4'), join(dest, 'x.bin')))).toBe(
      'PATH_INVALID',
    );
    expect(readdirSync(dest)).toEqual([]);
  });

  test('a file reached through a symlinked folder is refused by the `within` check', async () => {
    const via = join(src, 'linkdir', 'x.mp4');
    expect(await codeOfAsync(copyFileSafe(via, join(dest, 'x.bin'), { within: src }))).toBe(
      'PATH_INVALID',
    );
    expect(readdirSync(dest)).toEqual([]);
  });

  test('never overwrites the destination, and never writes through a destination symlink', async () => {
    writeFileSync(join(dest, 'taken.bin'), 'old');
    expect(await codeOfAsync(copyFileSafe(join(src, 'a.mp4'), join(dest, 'taken.bin')))).toBe(
      'PATH_INVALID',
    );
    expect(readFileSync(join(dest, 'taken.bin'), 'utf8')).toBe('old');
    symlinkSync(join(outside, 'secret.txt'), join(dest, 'trap.bin'));
    expect(await codeOfAsync(copyFileSafe(join(src, 'a.mp4'), join(dest, 'trap.bin')))).toBe(
      'PATH_INVALID',
    );
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('private');
  });

  test('a cancelled copy leaves no destination file', async () => {
    const big = join(src, 'big.mp4');
    writeFileSync(big, Buffer.alloc(32 * 1024 * 1024, 7));
    const ac = new AbortController();
    const p = copyFileSafe(big, join(dest, 'big.bin'), { signal: ac.signal });
    ac.abort();
    expect(await codeOfAsync(p)).toBe('CANCELLED');
    expect(readdirSync(dest)).toEqual([]);
  });

  test('a FIFO source is refused without blocking', async () => {
    try {
      execFileSync('mkfifo', [join(src, 'fifo.mp4')]);
    } catch {
      return;
    }
    expect(await codeOfAsync(copyFileSafe(join(src, 'fifo.mp4'), join(dest, 'f.bin')))).toBe(
      'PATH_INVALID',
    );
  });
});
