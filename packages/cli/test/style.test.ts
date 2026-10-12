// Phase 06 CLI: `vox style new|validate|trust|accept|remove` (step 5 round trip; render and DOM
// checks are skipped here, the slow engine tests cover them).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('vox style extract (phase 15)', () => {
  test('a fixed reference without a vision model → a measurements-only draft and its report', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vox-home-'));
    const jpg = join(home, 'frame.jpg');
    writeFileSync(jpg, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const measurements = {
      durationMs: 6000,
      width: 1080,
      height: 1920,
      shots: [
        { startMs: 0, endMs: 3000, speaker: null },
        { startMs: 3000, endMs: 6000, speaker: null },
      ],
      shotStats: { count: 2, meanMs: 3000, medianMs: 3000, p10Ms: 3000, p90Ms: 3000 },
      keyframes: [{ atMs: 0, kind: 'interval', file: jpg }],
      sheets: [jpg],
      palette: [
        { hex: '#F4F1EA', rgb: [244, 241, 234], share: 0.6, lightness: 0.94, saturation: 0.3 },
        { hex: '#2F6FED', rgb: [47, 111, 237], share: 0.4, lightness: 0.56, saturation: 0.84 },
      ],
      speakerRatio: null,
      captions: { summary: { detected: false, captionCount: 0 }, events: [], staticText: [] },
      notes: [],
    } as const;
    let stdout = '';
    let stderr = '';
    const code = await run(
      [
        'style',
        'extract',
        '/somewhere/ref clip.mp4',
        '--name',
        'Ref Clip',
        '--no-render',
        '--json',
      ],
      {
        stdout: (s) => (stdout += s),
        stderr: (s) => (stderr += s),
        env: { HOME: home, VOX_HOME: home },
        cwd: process.cwd(),
        agent: {
          styleExtractSteps: {
            ingest: () => Promise.resolve('m_ref000000000001'),
            measure: () => Promise.resolve(structuredClone(measurements) as never),
          },
        },
      },
    );
    expect(code, stdout + stderr).toBe(0);
    const r = JSON.parse(stdout) as { styleId: string; dir: string; describedBy: unknown };
    expect(r.styleId).toBe('ref-clip');
    expect(r.describedBy).toBeNull();
    expect(r.dir).toBe(join(home, 'styles', 'ref-clip'));
    expect(existsSync(join(r.dir, 'report.html'))).toBe(true);
    const style = JSON.parse(readFileSync(join(r.dir, 'style.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(style).toMatchObject({
      status: 'draft',
      trusted: false,
      source: { type: 'extracted', reference: 'ref clip.mp4' },
    });
    const usage = await vox(['style', 'extract', 'x.mp4'], { VOX_HOME: home });
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('--name');
  });
});
