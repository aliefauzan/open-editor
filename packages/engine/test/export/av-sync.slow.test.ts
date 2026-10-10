// A/V sync after the mux (phase 05 step 11, moved from 03): the engine-compiled 90 s spike fixture
// goes through the real `render` job (silent HyperFrames picture + the engine's WAV mix, muxed by
// ffmpeg), then the spike bench pairs each burnt-in flash frame with the click onset next to it.
// Every pair must be within one frame (33.3 ms at 30 fps). Set VOX_EVIDENCE_DIR to keep the report.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkSync } from '../../../../spike/bench/analyze.ts';
import { grayStream, pcm, probeFrames } from '../../../../spike/bench/lib.ts';
import { makeMainSequence } from '../../../../spike/lib/model.ts';
import { openEngine } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { PHONE_SRC, S, SPIKE_SRC, TOP, engineProject, spikeProjectDir } from '../compile/spike90-project.ts';
import { tempDir } from '../helpers/store.ts';
import { REPO_STYLES } from './project.ts';

// The source flash box (1720, 880, 160 x 160) framed `contain` on the 9:16 canvas; a 60 px crop
// inside it, as the spike bench's FLASH_CROP.
const FLASH = [Math.round(1720 * S + 15), Math.round(TOP + 880 * S + 15), 60, 60] as const;

describe.skipIf(!existsSync(SPIKE_SRC) || !existsSync(PHONE_SRC))('A/V sync after the mux (step 11)', () => {
  test('click onsets match the flash frames within one frame', async () => {
    const projectsDir = join(tempDir('vox-avsync-'), 'Projects');
    const dir = join(projectsDir, 'p_test');
    spikeProjectDir(dir);
    const seq = makeMainSequence();
    writeFileSync(join(dir, 'project.json'), JSON.stringify(engineProject(seq), null, 2));
    const e = openEngine({ projectsDir, stylesDirs: [REPO_STYLES], config: async () => ({}) });
    const file = join(tempDir('vox-avsync-out-'), 'spike90.mp4');
    const t0 = Date.now();
    const r = (await e.jobs.wait(
      e.jobs.start('render', { projectId: 'p_test', target: { file } }),
    )) as JobInfo<{ files: { path: string }[] }>;
    const renderMs = Date.now() - t0;
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    const { frames } = await probeFrames(file);
    const [flash, audio] = await Promise.all([grayStream(file, FLASH, 1, 1), pcm(file)]);
    const sync = checkSync(seq, flash, audio, 48000);
    const evidence = process.env['VOX_EVIDENCE_DIR'];
    if (evidence) {
      writeFileSync(
        join(evidence, 'av-sync-spike90.json'),
        JSON.stringify({ renderMs, frames, audioSec: audio.length / 48000, ...sync }, null, 2),
      );
    }
    expect(frames).toBe(2700);
    expect(sync.pairs.length).toBeGreaterThan(20);
    expect(sync.missingFlash).toBe(0);
    expect(sync.missingClick).toBe(0);
    expect(sync.maxAbsOffsetMs, JSON.stringify(sync.pairs.slice(0, 5))).toBeLessThan(sync.frameMs);
  }, 1_800_000);
});
