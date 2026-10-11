import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveToolPaths, which } from '../../src/tools.ts';

async function exe(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\necho fake\n');
  await chmod(path, 0o755);
}

describe('resolveToolPaths', () => {
  test('tools dir bin first, then PATH; missing tools are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vox-tools-'));
    const tools = join(root, 'tools');
    const pathDir = join(root, 'path');
    await mkdir(join(tools, 'bin'), { recursive: true });
    await mkdir(pathDir);
    await exe(join(tools, 'bin', 'yt-dlp'));
    await exe(join(pathDir, 'yt-dlp'));
    await exe(join(pathDir, 'deno'));
    await writeFile(join(pathDir, 'uv'), 'not executable');
    const t = resolveToolPaths({ toolsDir: tools, env: { PATH: `relative:${pathDir}` } });
    expect(t['dir']).toBe(tools);
    expect(t['yt-dlp']).toBe(join(tools, 'bin', 'yt-dlp'));
    expect(t['deno']).toBe(join(pathDir, 'deno'));
    expect(t['uv']).toBeUndefined();
    expect(t['models']).toBe(join(tools, 'models'));
    expect(t['pyEnv']).toBeUndefined();
    await mkdir(join(tools, 'py-env'));
    expect(resolveToolPaths({ toolsDir: tools, env: {} })['pyEnv']).toBe(join(tools, 'py-env'));
  });

  test('a missing tools dir gives no dir and no packaged py env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vox-tools-'));
    const t = resolveToolPaths({ toolsDir: join(root, 'nope'), env: { PATH: '' } });
    expect(t['dir']).toBeUndefined();
    expect(t['pyEnv']).toBeUndefined();
    expect(t['models']).toBe(join(root, 'nope', 'models'));
  });

  test('which skips relative PATH entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vox-tools-'));
    await exe(join(root, 'x'));
    expect(which('x', `.:${root}`)).toBe(join(root, 'x'));
    expect(which('x', '.')).toBeUndefined();
  });
});
