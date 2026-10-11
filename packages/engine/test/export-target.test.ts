// S32 / engine spec "Export targets" (D-13): `{ file }` or `{ dir }`, absolute, folder must exist
// and be writable (`EXPORT_PATH`), temp file in the target folder + rename, never a silent replace,
// ` (2)` suffix in folder mode, `-<n>` in the project's renders/, killed mid-write leaves nothing.

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { VoxError } from '../src/errors.ts';
import {
  HOST_TAG,
  STEM_MAX_BYTES,
  prepareExport,
  safeStem,
  sweepStaleTemps,
  writeExport,
  type ExportTarget,
} from '../src/export/target.ts';
import { runTool } from '../src/stages/media/run.ts';
import { codeOfAsync, removeDir, tempDir } from './media/helpers.ts';

const dirs: string[] = [];
let root = '';
let renders = '';
let out = '';

beforeEach(() => {
  root = tempDir('vox-export-');
  dirs.push(root);
  renders = join(root, 'project', 'renders');
  out = join(root, 'out');
  mkdirSync(out);
});
afterEach(() => {
  // Restore write permission so cleanup works after the read-only test.
  try {
    chmodSync(out, 0o755);
  } catch {
    // gone
  }
});
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

const write = (text: string) => async (tempPath: string) => {
  writeFileSync(tempPath, text);
};
const base = { defaultDir: '', stem: 'My Project-Main', ext: 'srt' };
const opts = (target?: ExportTarget, overwrite = false) => ({
  ...base,
  defaultDir: renders,
  target,
  overwrite,
});
const visible = (d: string) => readdirSync(d).filter((n) => !n.startsWith('.'));
const temps = (d: string) => readdirSync(d).filter((n) => n.startsWith('.vox-tmp-'));

/** Poll until `check` is true (instead of a fixed sleep), failing after `ms`. */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('targets', () => {
  test('{ file } writes exactly there and returns the path; no temp is left', async () => {
    const file = join(out, 'clip.srt');
    expect(await writeExport(opts({ file }), write('one'))).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe('one');
    expect(readdirSync(out)).toEqual(['clip.srt']);
  });

  test('{ dir } uses the engine name, then " (2)", " (3)" — never replaces', async () => {
    const t = { dir: out };
    expect(await writeExport(opts(t), write('1'))).toBe(join(out, 'My Project-Main.srt'));
    expect(await writeExport(opts(t), write('2'))).toBe(join(out, 'My Project-Main (2).srt'));
    expect(await writeExport(opts(t, true), write('3'))).toBe(join(out, 'My Project-Main (3).srt'));
    expect(readFileSync(join(out, 'My Project-Main.srt'), 'utf8')).toBe('1');
    expect(readdirSync(out).sort()).toEqual([
      'My Project-Main (2).srt',
      'My Project-Main (3).srt',
      'My Project-Main.srt',
    ]);
  });

  test('no target → the project renders/ folder (created), then "-2"', async () => {
    expect(await writeExport(opts(), write('a'))).toBe(join(renders, 'My Project-Main.srt'));
    expect(await writeExport(opts(), write('b'))).toBe(join(renders, 'My Project-Main-2.srt'));
    expect(readdirSync(renders).sort()).toEqual(['My Project-Main-2.srt', 'My Project-Main.srt']);
  });
});

describe('EXPORT_PATH', () => {
  test.each<[string, () => ExportTarget]>([
    ['missing folder (file)', () => ({ file: join(root, 'nope', 'a.srt') })],
    ['missing folder (dir)', () => ({ dir: join(root, 'nope') })],
    ['relative file', () => ({ file: 'a.srt' })],
    ['relative dir', () => ({ dir: 'out' })],
    ['NUL in path', () => ({ file: join(out, 'a\0.srt') })],
    ['dir is a file', () => (writeFileSync(join(out, 'f'), ''), { dir: join(out, 'f') })],
    ['file is a folder', () => (mkdirSync(join(out, 'sub')), { file: join(out, 'sub') })],
    [
      'both file and dir',
      () => ({ file: join(out, 'a.srt'), dir: out }) as unknown as ExportTarget,
    ],
    ['neither', () => ({}) as unknown as ExportTarget],
    ['null', () => null as unknown as ExportTarget],
    ['a string', () => out as unknown as ExportTarget],
  ])('%s', async (_label, target) => {
    const err = (await writeExport(opts(target()), write('x')).catch(
      (e: unknown) => e,
    )) as VoxError;
    expect(err).toBeInstanceOf(VoxError);
    expect(err.code).toBe('EXPORT_PATH');
    expect(err.hint.length).toBeGreaterThan(0);
  });

  test('read-only folder', async () => {
    chmodSync(out, 0o555);
    expect(await codeOfAsync(writeExport(opts({ dir: out }), write('x')))).toBe('EXPORT_PATH');
    expect(await codeOfAsync(writeExport(opts({ file: join(out, 'a.srt') }), write('x')))).toBe(
      'EXPORT_PATH',
    );
  });

  test('an existing file is not replaced without overwrite; with overwrite it is', async () => {
    const file = join(out, 'a.srt');
    writeFileSync(file, 'old');
    const err = (await writeExport(opts({ file }), write('new')).catch(
      (e: unknown) => e,
    )) as VoxError;
    expect(err.code).toBe('EXPORT_PATH');
    expect(err.hint).toMatch(/--overwrite/);
    expect(readFileSync(file, 'utf8')).toBe('old');
    expect(readdirSync(out)).toEqual(['a.srt']);
    expect(await writeExport(opts({ file }, true), write('new'))).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(readdirSync(out)).toEqual(['a.srt']);
  });

  test('a file that appears during the export is still not replaced (atomic no-replace commit)', async () => {
    const file = join(out, 'a.srt');
    const err = (await writeExport(opts({ file }), async (tmp) => {
      writeFileSync(tmp, 'mine');
      writeFileSync(file, 'theirs');
    }).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('EXPORT_PATH');
    expect(readFileSync(file, 'utf8')).toBe('theirs');
    expect(readdirSync(out)).toEqual(['a.srt']);
  });

  test('in folder mode a name taken during the export moves on to " (2)"', async () => {
    const got = await writeExport(opts({ dir: out }), async (tmp) => {
      writeFileSync(tmp, 'mine');
      writeFileSync(join(out, 'My Project-Main.srt'), 'theirs');
    });
    expect(got).toBe(join(out, 'My Project-Main (2).srt'));
    expect(readFileSync(join(out, 'My Project-Main.srt'), 'utf8')).toBe('theirs');
  });
});

describe('failed, cancelled or killed exports leave nothing (S32)', () => {
  const ffmpegWrite = (onSpawn?: (pid: number) => void) => (tmp: string, signal?: AbortSignal) =>
    runTool(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc=d=30:s=320x240',
        '-c:v',
        'libx264',
        tmp,
      ],
      { ...(signal ? { signal } : {}), ...(onSpawn ? { onSpawn } : {}) },
    ).then(() => undefined);
  // ffmpeg has written something into the hidden temp file.
  const tempHasBytes = (d: string): boolean =>
    temps(d).some((n) => readFileSync(join(d, n)).length > 0);

  test('a throwing producer → the error, and an empty folder', async () => {
    const err = await writeExport(opts({ dir: out }), async (tmp) => {
      writeFileSync(tmp, 'half');
      throw new Error('boom');
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('boom');
    expect(readdirSync(out)).toEqual([]);
  });

  test('a render cancelled mid-write (ffmpeg running) → CANCELLED, empty folder', async () => {
    const ac = new AbortController();
    const p = writeExport({ ...opts({ file: join(out, 'a.mp4') }), ext: 'mp4' }, ffmpegWrite(), {
      signal: ac.signal,
    });
    await until(() => tempHasBytes(out));
    expect(temps(out).every((n) => n.endsWith('.mp4'))).toBe(true);
    ac.abort();
    expect(await codeOfAsync(p)).toBe('CANCELLED');
    expect(readdirSync(out)).toEqual([]);
  });

  test('a render whose ffmpeg is killed from outside → TOOL_FAILED, empty folder', async () => {
    let pid = 0;
    const p = writeExport(
      { ...opts({ dir: out }), ext: 'mp4' },
      ffmpegWrite((n) => (pid = n)),
    );
    await until(() => pid > 0 && tempHasBytes(out));
    process.kill(pid, 'SIGKILL');
    expect(await codeOfAsync(p)).toBe('TOOL_FAILED');
    expect(readdirSync(out)).toEqual([]);
  });

  test('an engine process killed mid-write leaves only a hidden temp, which the next export sweeps', async () => {
    const target = fileURLToPath(new URL('../src/export/target.ts', import.meta.url));
    const script =
      `import { prepareExport } from ${JSON.stringify(target)};\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `const p = await prepareExport({ defaultDir: '/unused', stem: 'x', ext: 'mp4', target: { dir: ${JSON.stringify(out)} } });\n` +
      `writeFileSync(p.tempPath, 'partial');\n` +
      `process.stdout.write('ready\\n');\n` +
      `setInterval(() => {}, 1000);\n`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const closed = new Promise((r) => child.on('close', r));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && resolve());
        child.on('exit', (c) => reject(new Error(`child exited early (${String(c)})`)));
      });
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
    // No visible file; one hidden temp from the dead process.
    expect(visible(out)).toEqual([]);
    expect(temps(out)).toHaveLength(1);
    // The next export into the same folder removes it.
    await writeExport(opts({ dir: out }), write('ok'));
    expect(readdirSync(out)).toEqual(['My Project-Main.srt']);
  });

  test('only temps of this host whose process is gone (ESRCH) are swept', async () => {
    const name = (tag: string, pid: number | string) => `.vox-tmp-${tag}-${pid}-abcdef012345.mp4`;
    const otherTag = HOST_TAG === 'ffffff' ? 'eeeeee' : 'ffffff';
    const kept = [
      name(HOST_TAG, process.pid), // live (this process)
      name(HOST_TAG, 1), // pid 1 is never treated as gone
      name(HOST_TAG, '9999999999'), // out of range: kill() fails with something other than ESRCH
      name(otherTag, 999_999), // another machine on a shared folder
      '.x.mp4.vox-tmp-999999-abcdef.mp4', // not our temp pattern
    ];
    const gone = name(HOST_TAG, 999_999); // no such process on macOS (pid max 99998)
    for (const n of [...kept, gone]) writeFileSync(join(out, n), 'x');
    expect(await sweepStaleTemps(out)).toEqual([join(out, gone)]);
    for (const n of kept) expect(existsSync(join(out, n))).toBe(true);
  });

  test('a temp swapped for a symlink before commit is refused; the link target is untouched', async () => {
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'precious');
    const err = (await writeExport(opts({ dir: out }), async (tmp) => {
      writeFileSync(tmp, 'mine');
      renameSync(tmp, `${tmp}.moved`);
      symlinkSync(victim, tmp);
    }).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('EXPORT_PATH');
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect(visible(out)).toEqual([]);
  });

  test('a temp swapped for another regular file before commit is refused', async () => {
    const err = (await writeExport(opts({ dir: out }), async (tmp) => {
      writeFileSync(`${tmp}.theirs`, 'theirs');
      renameSync(`${tmp}.theirs`, tmp);
    }).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('EXPORT_PATH');
    expect(visible(out)).toEqual([]);
  });

  test('the producer gets the signal; a producer failing because of the cancel → CANCELLED', async () => {
    const ac = new AbortController();
    const err = writeExport(
      opts({ dir: out }),
      async (_tmp, signal) => {
        expect(signal).toBe(ac.signal);
        ac.abort();
        throw new Error('aborted inside');
      },
      { signal: ac.signal },
    );
    expect(await codeOfAsync(err)).toBe('CANCELLED');
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('prepareExport', () => {
  test('the temp file is hidden, in the target folder, ends with the extension; discard removes it', async () => {
    const p = await prepareExport({ ...opts({ file: join(out, 'final.mp4') }), ext: 'mp4' });
    expect(p.finalPath).toBe(join(out, 'final.mp4'));
    expect(p.tempPath.startsWith(join(out, `.vox-tmp-${HOST_TAG}-${process.pid}-`))).toBe(true);
    expect(p.tempPath.endsWith('.mp4')).toBe(true);
    expect(existsSync(p.tempPath)).toBe(true);
    await p.discard();
    expect(readdirSync(out)).toEqual([]);
  });

  test('a long final name still works: the temp name is short and the stem is byte-capped', async () => {
    const long = 'é'.repeat(200); // 400 bytes of UTF-8
    const got = await writeExport({ ...opts({ dir: out }), stem: long }, write('x'));
    const name = got.slice(out.length + 1);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name).toBe(`${'é'.repeat(STEM_MAX_BYTES / 2)}.srt`);
    const file = join(out, `${'a'.repeat(240)}.srt`);
    expect(await writeExport(opts({ file }), write('y'))).toBe(file);
  });
});

describe('safeStem', () => {
  test.each([
    ['My Project-Main', 'My Project-Main'],
    ['a/b\\c:d', 'a-b-c-d'],
    ['..', 'export'],
    ['.hidden', 'hidden'],
    ['  spaced  ', 'spaced'],
    ['tab\tnew\nline\0nul', 'tab new line nul'],
    ['', 'export'],
    ['x'.repeat(300), 'x'.repeat(STEM_MAX_BYTES)],
    ['ab' + '✂'.repeat(100), 'ab' + '✂'.repeat(49)], // 3-byte chars: never cut mid-character
    ['x'.repeat(STEM_MAX_BYTES - 1) + ' y', 'x'.repeat(STEM_MAX_BYTES - 1)],
    ['Café ✂️', 'Café ✂️'],
  ])('%j → %j', (input, want) => expect(safeStem(input)).toBe(want));
});
