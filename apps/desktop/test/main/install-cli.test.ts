// Menu "Install `vox` command" (plan phase 09 step 7): the `~/.local/bin` target under a temp HOME
// links to `<Resources>/cli/vox` and `vox --version` runs through the link; a regular file is not
// replaced; the `/usr/local/bin` target goes through the admin prompt (stubbed here; the real prompt
// is a MANUAL STEP).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { installCli } from '../../src/main/install-cli.ts';

function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), 'vox-cli-'));
  const resources = join(root, "Vox Studio's.app", 'Contents', 'Resources');
  mkdirSync(join(resources, 'cli'), { recursive: true });
  const script = join(resources, 'cli', 'vox');
  writeFileSync(script, '#!/bin/sh\n[ "$1" = --version ] && echo 0.0.0-test\n');
  chmodSync(script, 0o755);
  return { home: join(root, 'home'), resources, script };
}

describe('install vox command', () => {
  test('user target: ~/.local/bin/vox → Resources/cli/vox; vox --version works', async () => {
    const f = fakeApp();
    const r = await installCli({ resources: f.resources, target: 'user', home: f.home, path: '' });
    expect(r).toEqual({
      link: join(f.home, '.local', 'bin', 'vox'),
      target: f.script,
      onPath: false,
    });
    expect(readlinkSync(r.link)).toBe(f.script);
    expect(execFileSync(r.link, ['--version'], { encoding: 'utf8' }).trim()).toBe('0.0.0-test');
    // again (app moved or reinstalled): replaced, now on PATH
    const again = await installCli({
      resources: f.resources,
      target: 'user',
      home: f.home,
      path: `/usr/bin:${join(f.home, '.local', 'bin')}`,
    });
    expect(again.onPath).toBe(true);
  });

  test('a regular file at the link path is not replaced', async () => {
    const f = fakeApp();
    mkdirSync(join(f.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(f.home, '.local', 'bin', 'vox'), 'mine');
    await expect(
      installCli({ resources: f.resources, target: 'user', home: f.home }),
    ).rejects.toThrow(/not a link/);
  });

  test('system target: one admin command with quoted paths', async () => {
    const f = fakeApp();
    const cmds: string[] = [];
    const r = await installCli({
      resources: f.resources,
      target: 'system',
      home: f.home,
      runAsAdmin: async (c) => {
        cmds.push(c);
      },
    });
    expect(r.link).toBe('/usr/local/bin/vox');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain(`'${f.script.replace("'", `'\\''`)}' '/usr/local/bin/vox'`);
  });
});
