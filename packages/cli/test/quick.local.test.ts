// `vox quick <fixture path> --count 3 --length 4-8 --render` (phase 05 step 13, local tier: the real
// chain ingest → shots → transcribe (mlx-whisper) → facetrack → quickClips, then the real HyperFrames
// render) writes 3 MP4 + 3 SRT into --out-dir.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { run } from '../src/main.ts';

const HEAD = fileURLToPath(
  new URL('../../engine/test/fixtures/assets/media/talking-head-20s.mp4', import.meta.url),
);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('vox quick --render (step 13)', () => {
  test('3 captioned clips: 3 MP4 + 3 SRT in --out-dir', async () => {
    const out = tmp('vox-quick-out-');
    let stdout = '';
    let stderr = '';
    const code = await run(
      ['quick', HEAD, '--count', '3', '--length', '4-8', '--render', '--out-dir', out, '--json',
        '--projects-dir', join(tmp('vox-quick-'), 'Projects')], // prettier-ignore
      {
        stdout: (s) => (stdout += s),
        stderr: (s) => (stderr += s),
        env: { ...process.env, VOX_HOME: tmp('vox-quick-home-') },
        cwd: process.cwd(),
      },
    );
    expect(code, stderr + stdout).toBe(0);
    const r = JSON.parse(stdout) as {
      clips: unknown[];
      scorer: string;
      files: { mp4: string; srt: string }[];
    };
    expect(r.clips).toHaveLength(3);
    expect(r.scorer).toBe('heuristic');
    const names = readdirSync(out).sort();
    expect(names.filter((n) => n.endsWith('.mp4'))).toHaveLength(3);
    expect(names.filter((n) => n.endsWith('.srt'))).toHaveLength(3);
    for (const f of r.files)
      expect(readFileSync(f.srt, 'utf8')).toMatch(/^1\n\d\d:\d\d:\d\d,\d{3} --> /);
  }, 900_000);
});
