// Clip speed through the real render job (engine spec "Clip speed", plan D-62, phase 14e done-when):
// the phase 14e spike project (90 s barcode/flash/click source at 2×, 0.5×, 1× with sound, 4× and
// 0.25× picture only) renders through HyperFrames `data-playback-rate` and the engine mix with
// `atempo`; every frame shows the expected source frame and every flash/click pair is within one
// frame. Fixtures: packages/engine/test/fixtures/make.sh (or VOX_FIXTURES).
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { grayStream, pcm, probeFrames } from '../../../../spike/bench/lib.ts';
import {
  COUNTER,
  FLASH,
  SPEED_CLIPS,
  SPEED_SRC,
  speedProject,
} from '../../../../spike/bench/speed.ts';
import { checkSpeedFrames, checkSpeedSync } from '../../../../spike/bench/speed-analyze.ts';
import { openEngine } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';

const REPO = new URL('../../../../', import.meta.url).pathname;

describe.skipIf(!existsSync(SPEED_SRC))('clip speed render (phase 14e)', () => {
  test('frames exact at 0.25–4×, A/V within one frame at 0.5× and 2×', async () => {
    const work = mkdtempSync(join(tmpdir(), 'vox-speed-'));
    const projectsDir = join(work, 'Projects');
    const dir = join(projectsDir, 'p_speed');
    mkdirSync(join(dir, 'media'), { recursive: true });
    symlinkSync(SPEED_SRC, join(dir, 'media', 'spike-source-1080p.mp4'));
    writeFileSync(join(dir, 'project.json'), JSON.stringify(speedProject(true), null, 2));
    writeFileSync(join(dir, 'history.jsonl'), '');
    const e = openEngine({
      projectsDir,
      stylesDirs: [join(REPO, 'styles')],
      config: async () => ({}),
    });
    const r = (await e.jobs.wait(
      e.jobs.start('render', { projectId: 'p_speed', quality: 'draft' }),
    )) as JobInfo<{ files: { path: string }[] }>;
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    const out = r.result!.files[0]!.path;
    // the v2 spike project was migrated on open
    expect((await e.getProject('p_speed')).schemaVersion).toBe(3);

    const { frames } = await probeFrames(out);
    const [counters, flash, audio] = await Promise.all([
      grayStream(out, COUNTER, 16, 1),
      grayStream(out, FLASH, 1, 1),
      pcm(out),
    ]);
    const pic = checkSpeedFrames(SPEED_CLIPS, counters, frames);
    const sync = checkSpeedSync(
      SPEED_CLIPS.filter((c) => c.sound),
      30,
      flash,
      audio,
      48000,
    );
    const evidence = process.env['VOX_EVIDENCE_DIR'];
    if (evidence) {
      writeFileSync(
        join(evidence, 'render-speed.json'),
        JSON.stringify({ frames, picture: pic, sync }, null, 2),
      );
    }
    expect(frames).toBe(960);
    expect(pic.checked).toBeGreaterThan(900);
    expect(pic.mismatches.slice(0, 10)).toEqual([]);
    for (const c of SPEED_CLIPS) expect(pic.byClip[c.id]?.checked, c.id).toBeGreaterThan(0);
    expect(sync.missingFlash + sync.missingClick).toBe(0);
    expect(sync.pairs.length).toBeGreaterThanOrEqual(8);
    expect(sync.maxAbsOffsetMs).toBeLessThan(1000 / 30);
  }, 1_800_000);
});
