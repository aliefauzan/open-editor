// FCPXML export (phase 14g; engine "Stages" `export-timeline --format fcpxml`): the exportTimeline
// job writes `<name>.fcpxml` through otio-fcpx-xml-adapter next to the same `<name>-fcpxml-layers/` folder.
// A fake HyperFrames runner writes the layer pictures. The output goes through
// scripts/fcpxml-check.py (DTD validation when Apple's DTD is cached, plus a structural check of
// assets, clips and timing). That is an automated stand-in: the file is not imported in an NLE.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import type { HyperframesRun } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { REPO, exportEngine, exportProject, type Fixture } from './project.ts';

const fakeHf: HyperframesRun = async (args) => {
  const dir = args[1]!;
  const out = args[args.indexOf('-o') + 1]!;
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const dur = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? '1');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1080x1920:rate=30:duration=${dur}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
};

interface Check {
  dtdValid: boolean;
  pass: boolean;
  problems: string[];
  assets: number;
  spineClips: number;
  videoRefs: number;
  audioRefs: number;
  durationS: number;
}

/** Runs scripts/fcpxml-check.py (exit code 1 on problems is normal here: the JSON is the result). */
function fcpxmlCheck(path: string): Check {
  const r = spawnSync(
    'uv',
    [
      'run',
      '--project',
      join(REPO, 'py'),
      'python',
      join(REPO, 'scripts', 'fcpxml-check.py'),
      path,
    ],
    { encoding: 'utf8', cwd: join(REPO, 'py') },
  );
  return JSON.parse(r.stdout) as Check;
}

type Res = { path: string; layersDir: string; clips: number; layers: string[] };
let fx: Fixture;
beforeAll(async () => {
  fx = await exportProject(exportEngine({ hyperframes: fakeHf }), 3000);
}, 60_000);

const start = async (args: Record<string, unknown>) =>
  (await fx.e.jobs.wait(
    fx.e.jobs.start('exportTimeline', { projectId: fx.projectId, ...args }),
  )) as JobInfo<Res>;

describe('exportTimeline format fcpxml', () => {
  test('writes <name>.fcpxml + <name>-fcpxml-layers/, valid and structurally sound', async () => {
    const out = tempDir('vox-fcpxml-');
    const r = await start({ format: 'fcpxml', target: { dir: out } });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    const res = r.result!;
    expect(res.path).toBe(join(out, 'Demo-Main.fcpxml'));
    expect(res.layersDir).toBe(join(out, 'Demo-Main-fcpxml-layers'));
    expect(readdirSync(res.layersDir).filter((n) => n.endsWith('.mov')).length).toBe(
      res.layers.length,
    );
    const xml = readFileSync(res.path, 'utf8');
    expect(xml).toContain('<fcpxml version="1.8">');
    expect(xml).toContain('width="1080" height="1920"');
    const c = fcpxmlCheck(res.path);
    // Without Apple's DTD cached, that is the only problem allowed.
    expect(c.problems.filter((p) => !p.startsWith('DTD: no DTD'))).toEqual([]);
    if (c.dtdValid) expect(c.pass).toBe(true);
    expect(c.videoRefs + c.audioRefs).toBe(res.clips);
    expect(c.durationS).toBe(3);
    expect(c.spineClips).toBe(1); // one V1 media clip; the layers lie on lanes above it
    expect(c.audioRefs).toBe(1); // A1: the same file as the picture
    // The picture asset is the whole 20 s source file, not the 3 s used part.
    expect(xml).toMatch(
      /<asset name="[^"]*m_head\.mp4[^"]*" src="file:\/\/[^"]*m_head\.mp4"[^>]*duration="20\/1s"/,
    );
    // A second export never replaces the first.
    const r2 = await start({ format: 'fcpxml', target: { dir: out } });
    expect(r2.result?.path).toBe(join(out, 'Demo-Main (2).fcpxml'));
    expect(r2.result?.layersDir).toBe(join(out, 'Demo-Main (2)-fcpxml-layers'));
  }, 120_000);

  test('OTIO and FCPXML can go to the same folder (own layer folders)', async () => {
    const out = tempDir('vox-fcpxml-');
    const a = await start({ format: 'fcpxml', target: { dir: out } });
    const b = await start({ target: { dir: out } });
    expect(a.status, JSON.stringify(a.error)).toBe('done');
    expect(b.status, JSON.stringify(b.error)).toBe('done');
    expect(readdirSync(out).sort()).toEqual([
      'Demo-Main-fcpxml-layers',
      'Demo-Main-layers',
      'Demo-Main.fcpxml',
      'Demo-Main.otio',
    ]);
  }, 120_000);

  test('the default stays OTIO; an unknown format is refused', async () => {
    const out = tempDir('vox-fcpxml-');
    const r = await start({ target: { dir: out } });
    expect(r.result?.path).toBe(join(out, 'Demo-Main.otio'));
    await expect(start({ format: 'edl', target: { dir: out } })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  }, 120_000);
});
