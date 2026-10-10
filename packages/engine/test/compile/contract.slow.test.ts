// Step 11: HyperFrames contract tests on the pinned version (0.8.145). The emitted build lints with
// zero errors, and a 3 s fixture renders with `--strict-all` to the expected frame count.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Project } from '../../src/model/schema.ts';
import { build, mainProject } from './fixture.ts';
import { frameCount, lintErrors, makeMedia, meanLuma, render, writeBuild } from './hf.ts';

/** mainProject with every media item pointing at the generated files. */
function withRealMedia(p: Project): Project {
  for (const m of p.media) {
    if (m.kind === 'image') m.path = 'media/m_img.jpg';
    else {
      m.path = 'media/m_a.mp4';
      m.audioPath = 'media/m_a.mp4';
      m.proxyPath = 'media/m_a.mp4';
      delete m.cfrPath;
      delete m.vfr;
    }
  }
  return p;
}

describe('HyperFrames contract (step 11)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'vox-contract-')), 'p_test');
  makeMedia(dir);

  test.each(['render', 'preview'] as const)(
    '%s build: lint --json has zero errors',
    async (mode) => {
      const b = await build(withRealMedia(mainProject()), { mode }, undefined, { projectDir: dir });
      const out = writeBuild(b, join(dir, 'build', `lint-${mode}`));
      const { errors, raw } = lintErrors(out);
      expect(errors, raw).toEqual([]);
    },
    120_000,
  );

  test('a 3 s build renders with --strict-all to 90 frames, picture not blank', async () => {
    const b = await build(
      withRealMedia(mainProject()),
      {
        mode: 'render',
        range: { startMs: 0, endMs: 3000 },
      },
      undefined,
      { projectDir: dir },
    );
    const out = writeBuild(b, join(dir, 'build', 'seq_main'));
    const mp4 = join(dir, 'renders', 'contract.mp4');
    const r = render(out, mp4);
    expect(r.ok, r.log).toBe(true);
    expect(frameCount(mp4)).toBe(90);
    // frame 15: the title card (paper colour) over the video; frame 75: video under the overlay
    expect(meanLuma(mp4, 15)).toBeGreaterThan(40);
    expect(meanLuma(mp4, 75)).toBeGreaterThan(10);
  }, 900_000);
});
