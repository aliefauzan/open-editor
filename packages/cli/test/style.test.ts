// Phase 06 CLI: `vox style new|validate|trust|accept|remove` (step 5 round trip; render and DOM
// checks are skipped here, the slow engine tests cover them).
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { run } from '../src/main.ts';

async function vox(args: string[], env: Record<string, string>) {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { HOME: '/nonexistent-home', ...env },
    cwd: process.cwd(),
  });
  return { code, stdout, stderr };
}

describe('vox style', () => {
  test('new, validate, trust, accept, remove round trip', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vox-home-'));
    const env = { VOX_HOME: home };
    const dir = join(home, 'styles', 'mine');

    const n = await vox(['style', 'new', 'mine', '--name', 'Mine', '--json'], env);
    expect(n.code, n.stderr).toBe(0);
    expect(JSON.parse(n.stdout)).toEqual({ id: 'mine', dir });
    const style = JSON.parse(readFileSync(join(dir, 'style.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(style).toMatchObject({ id: 'mine', extends: 'base', status: 'draft', trusted: false });

    const dup = await vox(['style', 'new', 'base', '--json'], env);
    expect(dup.code).toBe(1);
    expect(JSON.parse(dup.stdout).error.code).toBe('STYLE_DUPLICATE');

    const v = await vox(['style', 'validate', 'mine', '--no-render', '--no-dom'], env);
    expect(v.code, v.stdout + v.stderr).toBe(0);
    expect(v.stdout).toContain('ok: mine');

    const ask = await vox(['style', 'trust', 'mine'], env);
    expect(ask.code).toBe(2);
    expect(ask.stderr).toContain('--yes');
    const t = await vox(['style', 'trust', 'mine', '--yes', '--json'], env);
    expect(t.code, t.stderr).toBe(0);
    const trust = () =>
      JSON.parse(readFileSync(join(home, 'trust.json'), 'utf8')) as {
        styles: Record<string, unknown>;
      };
    expect(Object.keys(trust().styles)).toEqual(['mine']);

    const a = await vox(['style', 'accept', 'mine'], env);
    expect(a.code, a.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'style.json'), 'utf8')).status).toBe('active');

    const builtIn = await vox(['style', 'remove', 'base', '--json'], env);
    expect(builtIn.code).toBe(1);
    const r = await vox(['style', 'remove', 'mine'], env);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(trust().styles).toEqual({});
  });

  test('validate base (static checks) passes; usage errors exit 2', async () => {
    const env = { VOX_HOME: mkdtempSync(join(tmpdir(), 'vox-home-')) };
    const v = await vox(['style', 'validate', 'base', '--no-render', '--no-dom', '--json'], env);
    expect(v.code, v.stdout).toBe(0);
    expect(JSON.parse(v.stdout)).toMatchObject({ styleId: 'base', ok: true, problems: [] });
    expect((await vox(['style', 'frob', 'x'], env)).code).toBe(2);
    expect((await vox(['style', 'validate'], env)).code).toBe(2);
  });
});
