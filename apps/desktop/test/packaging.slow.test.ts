// Plan phase 09 step 5 + 7 on the built app (`pnpm dist` first): `vox self-test --json` from the
// app's own CLI passes (D-12); the fuses read back match R4 S27; the "Install vox command" link
// target (`~/.local/bin`, temp HOME) runs `vox --version`; S31: no file in the `.app` changes while
// setup runs (fixture components, temp VOX_TOOLS_DIR / VOX_HOME) and a project compiles.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { describe, expect, test } from 'vitest';
import type { SetupStatusData } from '../src/shared/api.ts';
import { installCli } from '../src/main/install-cli.ts';
import {
  APP,
  EVIDENCE,
  appBinary,
  hashTree,
  launchPackaged,
  seedTools,
} from './helpers/packaged.ts';

const RES = join(APP, 'Contents', 'Resources');
/** `FuseState.ENABLE` (the package does not export the enum): the byte '1'. */
const ENABLE = 49;
const temp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('packaged app', () => {
  test('the .app exists (pnpm dist)', () => {
    expect(existsSync(appBinary(APP)), 'run `pnpm dist` first').toBe(true);
    expect(existsSync(join(RES, 'default_app.asar'))).toBe(false);
  });

  test('vox self-test --json from the app CLI: built modules pass, later ones skipped', () => {
    const home = temp('vox-st-');
    const out = execFileSync(join(RES, 'cli', 'vox'), ['self-test', '--json'], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    const r = JSON.parse(out) as {
      ok: boolean;
      packaged: boolean;
      checks: { name: string; status: string }[];
    };
    expect(r).toMatchObject({ ok: true, packaged: true });
    const st = Object.fromEntries(r.checks.map((c) => [c.name, c.status]));
    for (const n of ['resources', 'styles', 'geo', 'compile', 'silero-vad'])
      expect(st[n]).toBe('passed');
    expect(st['apple-helper']).toBe('notBuilt');
    expect(Object.values(st)).not.toContain('failed');
  });

  test('fuses (S27)', async () => {
    const wire = await getCurrentFuseWire(appBinary(APP));
    const on = (o: FuseV1Options) => Number(wire[o]) === ENABLE;
    expect(on(FuseV1Options.RunAsNode)).toBe(true);
    expect(on(FuseV1Options.EnableNodeOptionsEnvironmentVariable)).toBe(false);
    expect(on(FuseV1Options.EnableNodeCliInspectArguments)).toBe(false);
    expect(on(FuseV1Options.EnableEmbeddedAsarIntegrityValidation)).toBe(true);
    expect(on(FuseV1Options.OnlyLoadAppFromAsar)).toBe(true);
  });

  test('install vox command (~/.local/bin, temp HOME): vox --version through the link', async () => {
    const home = temp('vox-link-');
    const r = await installCli({ resources: RES, target: 'user', home });
    const v = execFileSync(r.link, ['--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    expect(v).toMatch(/^vox \d+\.\d+\.\d+/);
  });

  test('S31: setup + compile leave every file in the .app unchanged', async () => {
    const before = hashTree(APP);
    const home = temp('vox-s31-');
    const toolsDir = join(home, 'tools');
    mkdirSync(toolsDir, { recursive: true });
    await seedTools({ toolsDir, home, pyDir: join(RES, 'py') });
    const app = await launchPackaged(APP, {
      userData: join(home, 'user-data'),
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
        VOX_HOME: join(home, '.vox'),
        VOX_PROJECTS_DIR: join(home, 'Projects'),
        VOX_TOOLS_DIR: toolsDir,
        VOX_UPDATE_REPO: '',
      },
    });
    try {
      const r = await app.page.evaluate(async () => {
        try {
          const status = (await window.vox.setup.status()) as SetupStatusData;
          const p = (await window.vox.projects.create('S31')) as { id: string };
          const opened = await window.vox.projects.open(p.id);
          await window.vox.ops.apply({
            projectId: p.id,
            op: 'addSequence',
            args: { name: 'S31', id: 'seq_s31', styleId: 'base' },
            baseVersion: opened.version,
          });
          const again = (await window.vox.projects.open(p.id)) as unknown as {
            version: number;
            project: { sequences: { id: string; videoTracks: { id: string }[] }[] };
          };
          const track = again.project.sequences[0]!.videoTracks[0]!.id;
          await window.vox.ops.apply({
            projectId: p.id,
            op: 'addScene',
            args: {
              sequenceId: 'seq_s31',
              trackId: track,
              startMs: 0,
              durationMs: 1000,
              template: 'base/title',
              variables: { title: 'S31' },
            },
            baseVersion: again.version,
          });
          const url = await window.vox.preview.url(p.id, 'seq_s31');
          return { status, url };
        } catch (e) {
          return { error: JSON.stringify(e) };
        }
      });
      expect(r).not.toHaveProperty('error');
      if ('error' in r) return;
      expect(r.url).toMatch(/^vox-media:/);
      expect(r.status.components.filter((c) => c.state !== 'ready')).toEqual([]);
    } finally {
      await app.close();
    }
    // the bundled CLI compiles too (render + preview builds)
    execFileSync(join(RES, 'cli', 'vox'), ['self-test', '--json'], {
      env: { HOME: home, PATH: '/usr/bin:/bin', VOX_TOOLS_DIR: toolsDir },
    });
    const after = hashTree(APP);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (k) => before.get(k) !== after.get(k),
    );
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, 'bundle-unchanged.txt'),
      `S31: ${before.size} files hashed in Vox Studio.app before and after setup + compile; changed: ${changed.length}\n`,
    );
    expect(changed).toEqual([]);
  });
});
