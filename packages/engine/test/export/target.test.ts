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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import {
  prepareExport,
  safeStem,
  writeExport,
  type ExportTarget,
} from '../../src/export/target.ts';
import { runTool } from '../../src/stages/media/run.ts';
import { codeOfAsync, removeDir, tempDir } from '../media/helpers.ts';

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
  const ffmpegWrite = (signal?: AbortSignal) => (tmp: string) =>
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
      signal ? { signal } : {},
    ).then(() => undefined);

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
    const p = writeExport(
      { ...opts({ file: join(out, 'a.mp4') }), ext: 'mp4' },
      ffmpegWrite(ac.signal),
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 800));
    expect(readdirSync(out).some((n) => n.startsWith('.') && n.endsWith('.mp4'))).toBe(true);
    ac.abort();
    expect(await codeOfAsync(p)).toBe('CANCELLED');
    expect(readdirSync(out)).toEqual([]);
  });

  test('a render whose ffmpeg is killed from outside → TOOL_FAILED, empty folder', async () => {
    const p = writeExport({ ...opts({ dir: out }), ext: 'mp4' }, ffmpegWrite());
    await new Promise((r) => setTimeout(r, 800));
    const pk = spawn('pkill', ['-KILL', '-f', 'testsrc=d=30:s=320x240'], { stdio: 'ignore' });
    await new Promise((r) => pk.on('close', r));
    expect(await codeOfAsync(p)).toBe('TOOL_FAILED');
    expect(readdirSync(out)).toEqual([]);
  });

  test('an engine process killed mid-write leaves only a hidden temp, which the next export sweeps', async () => {
    const target = new URL('../../src/export/target.ts', import.meta.url).pathname;
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
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => d.toString().includes('ready') && resolve());
      child.on('exit', (c) => reject(new Error(`child exited early (${String(c)})`)));
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    // No visible file; one hidden temp from the dead process.
    expect(visible(out)).toEqual([]);
    expect(readdirSync(out).filter((n) => n.includes('.vox-tmp-'))).toHaveLength(1);
    // The next export into the same folder removes it.
    await writeExport(opts({ dir: out }), write('ok'));
    expect(readdirSync(out)).toEqual(['My Project-Main.srt']);
  });

  test('a live export temp of another process is not swept', async () => {
    const live = join(out, `.x.mp4.vox-tmp-${process.pid}-abcdef.mp4`);
    writeFileSync(live, 'busy');
    await writeExport(opts({ dir: out }), write('ok'));
    expect(existsSync(live)).toBe(true);
  });
});

describe('prepareExport', () => {
  test('the temp file is hidden, in the target folder, ends with the extension; discard removes it', async () => {
    const p = await prepareExport({ ...opts({ file: join(out, 'final.mp4') }), ext: 'mp4' });
    expect(p.finalPath).toBe(join(out, 'final.mp4'));
    expect(p.tempPath.startsWith(join(out, '.'))).toBe(true);
    expect(p.tempPath.endsWith('.mp4')).toBe(true);
    expect(existsSync(p.tempPath)).toBe(true);
    await p.discard();
    expect(readdirSync(out)).toEqual([]);
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
    ['x'.repeat(300), 'x'.repeat(120)],
    ['Café ✂️', 'Café ✂️'],
  ])('%j → %j', (input, want) => expect(safeStem(input)).toBe(want));
});
