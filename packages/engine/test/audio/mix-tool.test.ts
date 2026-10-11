// renderMix runs the ffmpeg the engine resolved (setup can find it outside PATH, e.g. a Homebrew
// prefix a GUI app's PATH lacks), not whatever `ffmpeg` is on PATH (phase 10b).
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMix } from '../../src/audio/graph.ts';

describe('renderMix ffmpeg path', () => {
  it('uses opts.ffmpeg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vox-mixtool-'));
    const fake = join(dir, 'my-ffmpeg');
    // writes the last argument (the output) and records that it ran
    writeFileSync(
      fake,
      `#!/bin/sh\nfor a; do last="$a"; done\n: > "$last"\necho ran > "${dir}/ran"\n`,
    );
    chmodSync(fake, 0o755);
    const seq = {
      id: 'seq_a',
      videoTracks: [],
      audioTracks: [],
      canvas: { fps: { num: 30, den: 1 } },
    };
    await renderMix(
      {
        seq,
        media: [],
        projectDir: dir,
        cues: [],
        sfxFiles: {},
        durationMs: 1000,
        preset: 'youtube',
      } as never,
      { out: join(dir, 'mix.wav'), normalize: false, ffmpeg: fake },
    );
    expect(readFileSync(join(dir, 'ran'), 'utf8').trim()).toBe('ran');
    expect(existsSync(join(dir, 'mix.wav'))).toBe(true);
  });
});
