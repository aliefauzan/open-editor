import {
  mkdtempSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  checkRelativePath,
  ensureProjectsDir,
  projectDirFor,
  resolveProjectPath,
  resolveProjectsDir,
} from '../src/paths.ts';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'vox-paths-')));
}

function project(): { root: string; dir: string; outside: string } {
  const root = tmp();
  const dir = join(root, 'p_1');
  mkdirSync(join(dir, 'media'), { recursive: true });
  writeFileSync(join(dir, 'media', 'm_1.mp4'), 'x');
  const outside = join(root, 'secret.txt');
  writeFileSync(outside, 'secret');
  return { root, dir, outside };
}

async function rejects(dir: string, rel: string): Promise<void> {
  await expect(resolveProjectPath(dir, rel)).rejects.toMatchObject({ code: 'PATH_INVALID' });
}

describe('path rule (S1)', () => {
  test('accepts a file inside the project and returns its real path', async () => {
    const { dir } = project();
    expect(await resolveProjectPath(dir, 'media/m_1.mp4')).toBe(join(dir, 'media', 'm_1.mp4'));
  });

  test('accepts an encoded name inside the project, decoded once', async () => {
    const { dir } = project();
    writeFileSync(join(dir, 'media', 'a b.mp4'), 'x');
    expect(await resolveProjectPath(dir, 'media/a%20b.mp4')).toBe(join(dir, 'media', 'a b.mp4'));
  });

  test('rejects any .. segment', async () => {
    const { dir } = project();
    await rejects(dir, '../secret.txt');
    await rejects(dir, 'media/../../secret.txt');
    await rejects(dir, 'media/..');
  });

  test('rejects encoded .. (%2e%2e, %2E%2E, mixed)', async () => {
    const { dir } = project();
    await rejects(dir, '%2e%2e/secret.txt');
    await rejects(dir, '%2E%2E%2Fsecret.txt');
    await rejects(dir, '.%2e/secret.txt');
  });

  test('rejects double-encoded .. (%252e%252e)', async () => {
    const { dir } = project();
    await rejects(dir, '%252e%252e/secret.txt');
    await rejects(dir, '%252e%252e%252fsecret.txt');
  });

  test('rejects absolute paths', async () => {
    const { dir, outside } = project();
    await rejects(dir, outside);
    await rejects(dir, '%2Fetc%2Fpasswd');
  });

  test('rejects NUL bytes, raw or encoded', async () => {
    const { dir } = project();
    await rejects(dir, 'media/m_1.mp4\0.png');
    await rejects(dir, 'media/m_1.mp4%00.png');
  });

  test('rejects a symlink that escapes the project', async () => {
    const { dir, outside } = project();
    symlinkSync(outside, join(dir, 'media', 'link.txt'));
    await rejects(dir, 'media/link.txt');
    symlinkSync(join(dir, '..'), join(dir, 'up'));
    await rejects(dir, 'up/secret.txt');
  });

  test('rejects the project folder itself, empty paths, backslashes and bad encoding', async () => {
    const { dir } = project();
    await rejects(dir, '');
    await rejects(dir, '.');
    await rejects(dir, 'media\\m_1.mp4');
    await rejects(dir, 'media/%E0%A4%A.mp4');
  });

  test('a missing file is accepted only with mustExist false and a real parent inside', async () => {
    const { dir } = project();
    await rejects(dir, 'media/new.mp4');
    expect(await resolveProjectPath(dir, 'media/new.mp4', { mustExist: false })).toBe(
      join(dir, 'media', 'new.mp4'),
    );
    await expect(
      resolveProjectPath(dir, 'nope/new.mp4', { mustExist: false }),
    ).rejects.toMatchObject({
      code: 'PATH_INVALID',
    });
  });

  test('checkRelativePath is the lexical part used by schemas', () => {
    expect(checkRelativePath('media/m_1.mp4')).toBe(true);
    expect(checkRelativePath('../x')).toBe(false);
    expect(checkRelativePath('/x')).toBe(false);
    expect(checkRelativePath('a/%2e%2e/x')).toBe(false);
  });

  test('projectDirFor accepts only project ids', () => {
    expect(projectDirFor('/p', 'p_abc123')).toBe(`/p${sep}p_abc123`);
    expect(() => projectDirFor('/p', '../x')).toThrow(/project id/);
    expect(() => projectDirFor('/p', 'p_A/..')).toThrow();
  });
});

describe('projects folder (D-10)', () => {
  test('resolution order: flag > env > config > default', () => {
    const env = { VOX_PROJECTS_DIR: '/env' };
    expect(resolveProjectsDir({ flag: '/flag', env, config: '/cfg', home: '/h' })).toEqual({
      dir: '/flag',
      source: 'flag',
    });
    expect(resolveProjectsDir({ env, config: '/cfg', home: '/h' })).toEqual({
      dir: '/env',
      source: 'env',
    });
    expect(resolveProjectsDir({ env: {}, config: '/cfg', home: '/h' })).toEqual({
      dir: '/cfg',
      source: 'config',
    });
    expect(resolveProjectsDir({ env: {}, home: '/h' })).toEqual({
      dir: join('/h', 'Movies', 'Vox Studio'),
      source: 'default',
    });
  });

  test('an empty env value is ignored; relative values resolve against cwd', () => {
    expect(
      resolveProjectsDir({ env: { VOX_PROJECTS_DIR: '' }, home: '/h', cwd: '/w' }).source,
    ).toBe('default');
    expect(resolveProjectsDir({ flag: 'rel', env: {}, home: '/h', cwd: '/w' }).dir).toBe(
      join('/w', 'rel'),
    );
  });

  test('ensureProjectsDir creates the folder with mode 0700', async () => {
    const dir = join(tmp(), 'a', 'Vox Studio');
    await ensureProjectsDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await ensureProjectsDir(dir); // idempotent
  });
});
