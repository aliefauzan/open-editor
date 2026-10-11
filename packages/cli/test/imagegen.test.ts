// `vox imagegen status|install|remove` (phase 14d) with the engine's fake mflux uv: the model table
// with licences, the install job, and `vox assets generate --provider mflux` after it.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { run } from '../src/main.ts';

const FAKE_UV = fileURLToPath(
  new URL('../../engine/test/assets/fake-uv-imagegen.mjs', import.meta.url),
);
const FACE = fileURLToPath(
  new URL('../../engine/test/fixtures/assets/faces/face-a.jpg', import.meta.url),
);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('vox imagegen', () => {
  const models = join(tmp('vox-cli-imagegen-'), 'models');
  const projects = join(tmp('vox-cli-imagegen-p-'), 'Projects');
  process.env['VOX_FAKE_IMAGE'] = FACE;
  async function vox(args: string[]) {
    let stdout = '';
    let stderr = '';
    const code = await run([...args, '--projects-dir', projects], {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env: { HOME: '/nonexistent-home', VOX_HOME: tmp('vox-cli-home-'), PATH: process.env['PATH'] },
      cwd: tmp('vox-cli-cwd-'),
      engine: {
        tools: { models, uv: FAKE_UV, py: tmp('vox-cli-py-') },
        imagegen: { freeBytes: () => 1e12 },
      },
    });
    return { code, stdout, stderr };
  }

  test('status lists both models with licence and size, then install → generate → remove', async () => {
    const s = await vox(['imagegen', 'status', '--json']);
    expect(s.code, s.stderr).toBe(0);
    const rows = JSON.parse(s.stdout) as {
      id: string;
      installed: boolean;
      license: string;
      gated: boolean;
    }[];
    expect(rows.map((r) => [r.id, r.installed, r.license, r.gated])).toEqual([
      ['z-image-turbo', false, 'Apache-2.0', false],
      ['flux1-schnell', false, 'Apache-2.0', true],
    ]);
    const text = await vox(['imagegen', 'status']);
    expect(text.stdout).toMatch(
      /z-image-turbo\tnot installed \(32\.8 GB download\)\tApache-2\.0\n/,
    );
    expect(text.stdout).toMatch(/flux1-schnell.*gated on Hugging Face/);

    const bad = await vox(['imagegen', 'install', '--model', 'sdxl']);
    expect(bad.code).toBe(2);

    const created = await vox(['new', 'Gen', '--json']);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    const none = await vox(['assets', 'generate', id, 'a fox', '--json']);
    expect(JSON.parse(none.stdout).error.hint).toMatch(/vox imagegen install/);

    const inst = await vox(['imagegen', 'install']);
    expect(inst.code, inst.stderr).toBe(0);
    expect(inst.stdout).toMatch(/--provider mflux/);
    expect(existsSync(join(models, 'mflux', 'z-image-turbo', 'vox-model.json'))).toBe(true);
    const gen = await vox(['assets', 'generate', id, 'a fox', '--provider', 'mflux', '--json']);
    expect(gen.code, gen.stderr + gen.stdout).toBe(0);
    expect(JSON.parse(gen.stdout).provider).toBe('mflux');

    const rm = await vox(['imagegen', 'remove']);
    expect(rm.stdout).toBe('z-image-turbo removed\n');
    expect((await vox(['imagegen', 'remove'])).stdout).toBe('z-image-turbo was not installed\n');
  }, 60_000);
});
