// Step 5 (slow part): every `base` scene fixture back-to-back (1 s each) on V2 over video, with the
// crossfade and dip-to-black transitions on V1. The build lints with zero errors and renders with
// `--strict-all`; every scene's middle frame is a real picture.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Item, Sequence } from '../../src/model/schema.ts';
import { baseProject, emptySequence, F30, track } from '../helpers/project.ts';
import { build, clip, media, registry, scene } from '../compile/fixture.ts';
import { frameCount, lintErrors, makeMedia, meanLuma, render, writeBuild } from '../compile/hf.ts';

const SCENE_MS = 1000;

function allFixturesProject() {
  const base = registry().get('base');
  const scenes: Item[] = [];
  for (const t of Object.values(base.templates)) {
    if (t.kind !== 'scene') continue;
    for (const f of t.fixtures) {
      const n = scenes.length;
      scenes.push(
        scene(
          `it_s${n}_${basename(f, '.json')}`,
          t.id,
          t.version,
          n * SCENE_MS,
          SCENE_MS,
          JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>,
        ),
      );
    }
  }
  const total = scenes.length * SCENE_MS;
  const third = total / 3;
  const seq: Sequence = {
    ...emptySequence('seq_base', F30),
    videoTracks: [
      track('V1', [
        clip('it_v1', 'm_a', 0, third, 500),
        clip('it_v2', 'm_a', third, third, 3000, {
          transitionIn: { template: 'base/crossfade', durationMs: 500 },
        }),
        clip('it_v3', 'm_a', 2 * third, third, 6000, {
          transitionIn: { template: 'base/dip-to-black', durationMs: 600 },
        }),
      ]),
      track('V2', scenes),
    ],
  };
  const m = media('m_a', {
    path: 'media/m_a.mp4',
    proxyPath: 'media/m_a.mp4',
    audioPath: 'media/m_a.mp4',
    durationMs: 12000,
  });
  return { project: baseProject(seq, [m]), scenes, total };
}

describe('styles/base templates render (step 5)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'vox-base-')), 'p_test');
  makeMedia(dir, 12);
  const { project, scenes, total } = allFixturesProject();

  test('at least two fixtures per scene template, all compiled', () => {
    expect(scenes.length).toBeGreaterThanOrEqual(6);
  });

  test('every fixture lints with zero errors and renders non-blank', async () => {
    const b = await build(project, { mode: 'render' }, undefined, { projectDir: dir });
    expect(b.warnings).toEqual([]);
    const out = writeBuild(b, join(dir, 'build', 'seq_base'));
    const { errors, raw } = lintErrors(out);
    expect(errors, raw).toEqual([]);
    const mp4 = join(dir, 'renders', 'base.mp4');
    const r = render(out, mp4);
    expect(r.ok, r.log).toBe(true);
    expect(frameCount(mp4)).toBe((total / 1000) * 30);
    for (let i = 0; i < scenes.length; i++) {
      const f = Math.round(((i + 0.5) * SCENE_MS * 30) / 1000);
      expect(meanLuma(mp4, f), `${scenes[i]!.id} at frame ${f}`).toBeGreaterThan(10);
    }
  }, 900_000);
});
