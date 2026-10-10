// Step 12: the spike's 90 s main sequence rebuilt as an engine project and compiled by the engine,
// with captions from transcripts/spike-90s.json (R7). The render is checked with the spike bench's
// cut-accuracy analysis (frame counters read back per frame, flat-frame check). A/V sync needs the
// mux and is checked in phase 05. Fixtures: packages/engine/test/fixtures/make.sh (or VOX_FIXTURES).
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkCuts } from '../../../../spike/bench/analyze.ts';
import { grayStream, probeFrames } from '../../../../spike/bench/lib.ts';
import { COUNTER_CROP, makeMainSequence } from '../../../../spike/lib/model.ts';
import { build } from './fixture.ts';
import { render, writeBuild } from './hf.ts';
import { BAND, LAND_CROP, PHONE_SRC, SPIKE_SRC, engineProject, spikeProjectDir } from './spike90-project.ts';

describe.skipIf(!existsSync(SPIKE_SRC) || !existsSync(PHONE_SRC))(
  'spike 90 s fixture through the engine (step 12)',
  () => {
    test('compiles, renders 2700 frames, and every checked frame shows the expected source frame', async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'vox-spike90-')), 'p_test');
      const transcript = spikeProjectDir(dir);

      const seq = makeMainSequence();
      const b = await build(engineProject(seq), { mode: 'render' }, undefined, {
        projectDir: dir,
        transcriptOf: (m) => (m.id === 'm_spike' ? transcript : undefined),
      });
      expect(b.warnings).toEqual([]);
      expect(b.durationMs).toBe(90000);
      expect(b.captions.length).toBeGreaterThan(20);
      const out = writeBuild(b, join(dir, 'build', 'seq_spike90'));
      const mp4 = join(dir, 'renders', 'spike90.mp4');
      const r = render(out, mp4);
      expect(r.ok, r.log).toBe(true);

      const { frames } = await probeFrames(mp4);
      const [land, phone, band] = await Promise.all([
        grayStream(mp4, LAND_CROP, 16, 1),
        grayStream(mp4, COUNTER_CROP.phone, 16, 1),
        grayStream(mp4, BAND, 32, 18),
      ]);
      const rep = checkCuts(seq, { spike: land, ntsc: land, phone }, band, 32 * 18, frames);
      const evidence = process.env['VOX_EVIDENCE_DIR'];
      if (evidence)
        writeFileSync(join(evidence, 'spike90-engine.json'), JSON.stringify(rep, null, 2));
      expect(frames).toBe(2700);
      expect(rep.checked).toBeGreaterThan(2000);
      expect(rep.cuts).toBeGreaterThan(20);
      expect(rep.mismatches.slice(0, 10)).toEqual([]);
      expect(rep.cutErrors).toBe(0);
      expect(rep.flat).toEqual([]);
    }, 1_800_000);
  },
);
