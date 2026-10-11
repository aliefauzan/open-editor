// Step 12: the spike's 90 s main sequence rebuilt as an engine project and compiled by the engine,
// with captions from transcripts/spike-90s.json (R7). The render is checked with the spike bench's
// cut-accuracy analysis (frame counters read back per frame, flat-frame check). A/V sync needs the
// mux and is checked in phase 05. Fixtures: packages/engine/test/fixtures/make.sh (or VOX_FIXTURES).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkCuts } from '../../../../spike/bench/analyze.ts';
import { grayStream, probeFrames } from '../../../../spike/bench/lib.ts';
import {
  COUNTER_CROP,
  makeMainSequence,
  type Sequence as SpikeSequence,
} from '../../../../spike/lib/model.ts';
import { ms } from '../../src/model/fps.ts';
import type { Item, Project, Sequence, Transcript } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { baseProject, emptySequence, F30, track } from '../helpers/project.ts';
import { build, clip, image, media, scene } from './fixture.ts';
import { render, writeBuild } from './hf.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
const FIXTURES = process.env['VOX_FIXTURES'] ?? join(FIXTURES_DIR, 'out');
const SPIKE_SRC = join(FIXTURES, 'spike-source-1080p.mp4');
const PHONE_SRC = join(FIXTURES, 'phone-vfr-20s.mp4');
const FACE = join(FIXTURES_DIR, 'assets', 'faces', 'face-a.jpg');

// Landscape sources are framed `contain` on the 9:16 canvas: scale 1080/1920 = 0.5625, top 656.25.
// The source counter (40, 40, 640 x 40) lands at (22.5, 678.75, 360 x 22.5); the band is the picture.
const S = 1080 / 1920;
const TOP = (1920 - 1080 * S) / 2;
const LAND_CROP = [
  Math.round(40 * S),
  Math.round(TOP + 40 * S),
  Math.round(640 * S),
  Math.floor(40 * S),
] as const;
const BAND = [0, Math.ceil(TOP), 1080, Math.floor(1080 * S) - 2] as const;

const t = (f: number) => ms(f, F30);

/** The spike sequence as an engine project (same V1 picture at every frame the bench checks). */
function engineProject(seq: SpikeSequence): Project {
  const v1: Item[] = [];
  const v2: Item[] = [];
  const a1: Item[] = [];
  const contain = { frame: { mode: 'contain' as const } };
  const src = { spike: 'm_spike', phone: 'm_phone', ntsc: 'm_spike' } as const;
  const items = seq.items;
  for (const it of items) {
    const id = `it_${it.id.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    if (it.kind === 'video') {
      let { startF, durF, inF } = it;
      const extra: Record<string, unknown> = it.src === 'phone' ? {} : { ...contain };
      // the spike overlaps a crossfade by hand (incoming 7 frames early, outgoing 8 longer); the
      // engine is given the plain cut and overlaps the clips itself (blendsShots)
      if (it.fadeInF) {
        startF += 7;
        durF -= 7;
        inF += 7;
        extra['transitionIn'] = { template: 'base/crossfade', durationMs: t(it.fadeInF) };
      } else if (
        items.some((n) => n.kind === 'video' && n.fadeInF && n.startF + 7 === startF + durF - 8)
      ) {
        durF -= 8;
      }
      v1.push(clip(id, src[it.src], t(startF), t(startF + durF) - t(startF), t(inF), extra));
    } else if (it.kind === 'image') {
      v1.push(
        clip(id, 'm_face', t(it.startF), t(it.startF + it.durF) - t(it.startF), 0, {
          motion: { type: 'push-in', amount: 0.1 },
        }),
      );
    } else if (it.kind === 'scene') {
      const at = t(it.startF);
      const dur = t(it.startF + it.durF) - at;
      if (it.template === 'video-slot') {
        // the slot shows the spike source from slotInF: an engine clip shows the same picture
        v1.push(clip(id, 'm_spike', at, dur, t(it.slotInF ?? 0), contain));
      } else if (it.template === 'lower-third') {
        v2.push(
          scene(id, 'base/text-overlay', '1.0.0', at, dur, {
            text: it.vars.title,
            position: 'bottom',
          }),
        );
      } else {
        (it.track === 'V1' ? v1 : v2).push(
          scene(id, 'base/title', '1.0.0', at, dur, { title: it.vars.title }),
        );
      }
    } else {
      a1.push(
        clip(id, src[it.src], t(it.startF), t(it.startF + it.durF) - t(it.startF), t(it.inF)),
      );
    }
  }
  const s: Sequence = {
    ...emptySequence('seq_spike90', F30),
    name: 'spike-90s (engine)',
    videoTracks: [track('V1', v1), track('V2', v2)],
    audioTracks: [track('A1', a1)],
    captions: { ...CAPTION_DEFAULTS, overrides: [] },
  };
  return baseProject(s, [
    media('m_spike', {
      path: 'media/spike-source-1080p.mp4',
      proxyPath: 'media/spike-source-1080p.mp4',
      audioPath: 'media/spike-source-1080p.mp4',
      durationMs: 90000,
      transcriptPath: 'transcripts/m_spike.json',
    }),
    media('m_phone', {
      path: 'media/phone-vfr-20s.mp4',
      proxyPath: 'cfr/m_phone.mp4',
      audioPath: 'cfr/m_phone.mp4',
      cfrPath: 'cfr/m_phone.mp4',
      vfr: true,
      durationMs: 20000,
      width: 1080,
      height: 1920,
      transcriptPath: undefined,
      transcriptRev: undefined,
    }),
    { ...image('m_face'), path: 'media/face-a.jpg', width: 720, height: 900 },
  ]);
}

describe.skipIf(!existsSync(SPIKE_SRC) || !existsSync(PHONE_SRC))(
  'spike 90 s fixture through the engine (step 12)',
  () => {
    test('compiles, renders 2700 frames, and every checked frame shows the expected source frame', async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'vox-spike90-')), 'p_test');
      mkdirSync(join(dir, 'media'), { recursive: true });
      mkdirSync(join(dir, 'cfr'));
      symlinkSync(SPIKE_SRC, join(dir, 'media', 'spike-source-1080p.mp4'));
      symlinkSync(PHONE_SRC, join(dir, 'media', 'phone-vfr-20s.mp4'));
      symlinkSync(FACE, join(dir, 'media', 'face-a.jpg'));
      // engine spec "Ingest analysis": the CFR copy at the nearest fixed rate (as spike/make-project.ts)
      execFileSync('ffmpeg', [
        '-v', 'error', '-y', '-i', PHONE_SRC,
        '-vf', 'fps=30', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy', '-movflags', '+faststart',
        join(dir, 'cfr', 'm_phone.mp4'),
      ]); // prettier-ignore
      const transcript = JSON.parse(
        readFileSync(join(FIXTURES_DIR, 'transcripts', 'spike-90s.json'), 'utf8'),
      ) as Transcript;

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
