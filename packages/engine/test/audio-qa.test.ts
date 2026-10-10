// Audio QA through `engine.jobs` (phase 05 steps 8d, 8e; engine "Audio QA", D-14, D-15): the job
// mixes the stems and the final mix of a sequence, maps the compiled cues and the `--loudness`
// preset to the Python request, and writes `qa.json`, `qa.png`, `LISTEN.md` to
// `renders/qa/<sequenceId>/`; `--kit` checks a style's SFX and writes `qa/kit-<styleId>.png`.
// Step 8e: a `tiktok` render passes the tiktok loudness check and a `broadcast` render fails it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { HyperframesRun } from '../src/api.ts';
import type { JobInfo } from '../src/jobs.ts';
import { repoPyProject, runPyTool } from '../src/py.ts';
import { tempDir } from './helpers/store.ts';
import { REPO_STYLES, exportEngine, exportProject, type Fixture } from './export/project.ts';

const KIT = join(import.meta.dirname, 'fixtures', 'styles', 'kit');

const fakeHf: HyperframesRun = async (args) => {
  const out = args[args.indexOf('-o') + 1]!;
  const html = readFileSync(join(args[1]!, 'index.html'), 'utf8');
  const dur = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? '1');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:size=1080x1920:rate=30:duration=${dur}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
};

type Qa = {
  mode: string;
  pass: boolean;
  outDir: string;
  png: string;
  targetLufs: number;
  checks: { id: string; status: string; integratedLufs?: number }[];
  listen: unknown[];
};

let fx: Fixture;
beforeAll(async () => {
  fx = await exportProject(
    exportEngine({ stylesDirs: [REPO_STYLES, KIT], hyperframes: fakeHf }),
    12000,
  );
}, 60_000);

async function run<T>(kind: string, args: unknown): Promise<JobInfo<T>> {
  return (await fx.e.jobs.wait(fx.e.jobs.start(kind, args))) as JobInfo<T>;
}

describe('audioQa job', () => {
  test('youtube by default: qa.json, qa.png, LISTEN.md in renders/qa/<seq>/, five checks', async () => {
    const r = await run<Qa>('audioQa', { projectId: fx.projectId });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    const q = r.result!;
    expect(q.mode).toBe('mix');
    expect(q.outDir).toBe(join(fx.dir, 'renders', 'qa', 'seq_a'));
    for (const f of ['qa.json', 'qa.png', 'LISTEN.md'])
      expect(existsSync(join(q.outDir, f))).toBe(true);
    expect(q.targetLufs).toBe(-14);
    expect(q.checks.map((c) => c.id)).toEqual([
      'cueTiming',
      'oneEventPerCue',
      'spacing',
      'sfxUnderSpeech',
      'loudness',
    ]);
    const loud = q.checks.find((c) => c.id === 'loudness')!;
    expect(loud.status).toBe('pass');
    expect(Math.abs(loud.integratedLufs! + 14)).toBeLessThanOrEqual(1);
  }, 120_000);

  test('--loudness tiktok checks against -12 LUFS', async () => {
    const r = await run<Qa>('audioQa', { projectId: fx.projectId, loudness: 'tiktok' });
    expect(r.result?.targetLufs).toBe(-12);
    const loud = r.result?.checks.find((c) => c.id === 'loudness');
    expect(loud?.status, JSON.stringify(loud)).toBe('pass');
  }, 120_000);

  test('--kit writes qa/kit-<styleId>.png and judges each SFX file', async () => {
    const r = await run<{ mode: string; png: string; files: { status?: string }[] }>('audioQa', {
      projectId: fx.projectId,
      kit: 'kit',
    });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    expect(r.result?.mode).toBe('kit');
    expect(r.result?.png).toBe(join(fx.dir, 'renders', 'qa', 'kit-kit.png'));
    expect(existsSync(r.result!.png)).toBe(true);
  }, 60_000);

  test('an unknown style for --kit fails with STYLE_NOT_FOUND', async () => {
    const r = await run('audioQa', { projectId: fx.projectId, kit: 'nope' });
    expect(r.error?.code).toBe('STYLE_NOT_FOUND');
  });
});

describe('loudness against renders (step 8e)', () => {
  test('a tiktok render passes the tiktok check; a broadcast render fails it', async () => {
    const out = tempDir('vox-qa-renders-');
    const status: Record<string, string> = {};
    for (const preset of ['tiktok', 'broadcast'] as const) {
      const r = await run<{ files: { path: string }[] }>('render', {
        projectId: fx.projectId,
        quality: 'draft',
        loudness: preset,
        target: { file: join(out, `${preset}.mp4`) },
      });
      expect(r.status, JSON.stringify(r.error)).toBe('done');
      const file = r.result!.files[0]!.path;
      const q = await runPyTool(
        'audioqa',
        {
          mix: file,
          stems: { sfx: file },
          cues: [],
          fps: 30,
          target: -12,
          outDir: tempDir('vox-qa-'),
        },
        z.looseObject({ checks: z.array(z.looseObject({ id: z.string(), status: z.string() })) }),
        { pyProject: repoPyProject() },
      );
      status[preset] = q.checks.find((c) => c.id === 'loudness')!.status;
    }
    expect(status).toEqual({ tiktok: 'pass', broadcast: 'fail' });
  }, 180_000);
});
