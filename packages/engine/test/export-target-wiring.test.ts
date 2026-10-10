// Render and export wiring without Chrome (phase 05 steps 5–8b, 8c): a fake HyperFrames runner
// records its arguments and writes a test picture; ffmpeg mixes and muxes for real. Quality is
// always passed, `--captions none` drops the caption layer, SRT/VTT match `deriveCaptions` on the
// frame grid, export targets apply, `credits` lists the archive assets in use, `preview` builds
// and returns the `npx hyperframes play <buildDir>` call.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { captionsToSrt, captionsToVtt, type HyperframesRun } from '../src/api.ts';
import type { JobInfo } from '../src/jobs.ts';
import { tempDir } from './helpers/store.ts';
import { exportEngine, exportProject, type Fixture } from './export/project.ts';

const calls: string[][] = [];
/** Fake `hyperframes render`: a 1080×1920 test picture as long as the build says. */
const fakeHf: HyperframesRun = async (args) => {
  calls.push(args);
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

let fx: Fixture;
beforeAll(async () => {
  fx = await exportProject(exportEngine({ hyperframes: fakeHf }), 3000);
}, 60_000);

async function run<T>(kind: string, args: unknown): Promise<JobInfo<T>> {
  return (await fx.e.jobs.wait(fx.e.jobs.start(kind, args))) as JobInfo<T>;
}

describe('render wiring', () => {
  test('quality is always passed (default standard); the mux keeps the picture and adds AAC', async () => {
    calls.length = 0;
    const r = await run<{ files: { path: string }[]; quality: string }>('render', {
      projectId: fx.projectId,
    });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    expect(r.result?.quality).toBe('standard');
    const a = calls[0]!;
    expect(a.slice(0, 1)).toEqual(['render']);
    expect(a[a.indexOf('--quality') + 1]).toBe('standard');
    expect(a[a.indexOf('--fps') + 1]).toBe('30');
    const probe = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name',
        '-of',
        'csv=p=0',
        r.result!.files[0]!.path,
      ],
      { encoding: 'utf8' },
    );
    expect(probe.trim().split('\n').sort()).toEqual(['aac,audio', 'h264,video']);
  }, 60_000);

  test('--captions none leaves the caption layer out of the render build; burn keeps it', async () => {
    const html = () => readFileSync(join(fx.dir, 'build', 'seq_a-render', 'index.html'), 'utf8');
    await run('render', { projectId: fx.projectId, quality: 'draft', captions: 'none' });
    expect(html()).not.toContain('id="captions"');
    await run('render', { projectId: fx.projectId, quality: 'draft', captions: 'burn' });
    expect(html()).toContain('id="captions"');
  }, 60_000);

  test('--range-ms renders the window only', async () => {
    const r = await run<{ files: { durationMs: number }[] }>('render', {
      projectId: fx.projectId,
      quality: 'draft',
      range: { startMs: 1000, endMs: 2000 },
    });
    expect(r.result?.files[0]?.durationMs).toBe(1000);
  }, 60_000);

  test('bad combinations fail at start', () => {
    let err: unknown;
    try {
      fx.e.jobs.start('render', {
        projectId: fx.projectId,
        all: true,
        target: { file: '/tmp/a.mp4' },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(JSON.stringify((err as { details?: unknown }).details)).toMatch(/folder/);
    expect(() =>
      fx.e.jobs.start('render', { projectId: fx.projectId, quality: 'looks' }),
    ).toThrow();
  });
});

describe('export-captions (step 6)', () => {
  test('SRT and VTT equal deriveCaptions, on the 30 fps grid', async () => {
    const chunks = await fx.e.captions(fx.projectId, 'seq_a');
    expect(chunks.length).toBeGreaterThan(2);
    const out = tempDir('vox-cap-');
    const srt = await run<{ path: string; chunks: number }>('exportCaptions', {
      projectId: fx.projectId,
      format: 'srt',
      target: { dir: out },
    });
    expect(srt.result?.path).toBe(join(out, 'Demo-Main.srt'));
    expect(readFileSync(srt.result!.path, 'utf8')).toBe(captionsToSrt(chunks));
    const vtt = await run<{ path: string }>('exportCaptions', {
      projectId: fx.projectId,
      format: 'vtt',
      target: { file: join(out, 'x.vtt') },
    });
    expect(readFileSync(vtt.result!.path, 'utf8')).toBe(captionsToVtt(chunks));
    for (const c of chunks) {
      for (const t of [c.startMs, c.endMs]) {
        const f = (t * 30) / 1000;
        expect(Math.abs(f - Math.round(f))).toBeLessThan(0.05);
      }
    }
    const again = await run('exportCaptions', {
      projectId: fx.projectId,
      format: 'vtt',
      target: { file: join(out, 'x.vtt') },
    });
    expect(again.error?.code).toBe('EXPORT_PATH');
  });

  test('no target: the project renders/ folder', async () => {
    const r = await run<{ path: string }>('exportCaptions', { projectId: fx.projectId });
    expect(r.result?.path).toMatch(/\/renders\/Demo-Main(-\d+)?\.srt$/);
  });
});

describe('credits (step 8)', () => {
  test('lists archive assets the sequences use, with author, licence and link', async () => {
    const e = fx.e;
    const add = async (id: string, author: string) => {
      copyFileSync(
        new URL('./fixtures/assets/faces/face-a.jpg', import.meta.url).pathname,
        join(fx.dir, 'media', `${id}.jpg`),
      );
      await e.applyOp(
        fx.projectId,
        {
          op: 'addMedia',
          args: {
            media: {
              id,
              kind: 'image',
              path: `media/${id}.jpg`,
              width: 64,
              height: 64,
              origin: {
                type: 'archive',
                url: `https://commons.wikimedia.org/wiki/File:${id}.jpg`,
                license: 'CC BY-SA 4.0',
                licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
                author,
                attribution: `"${id}" by ${author}, CC BY-SA 4.0`,
              },
              tags: [],
            },
          },
        } as never,
        { actor: 'cli' },
      );
    };
    await add('m_used1', 'Ana');
    await add('m_unused', 'Bo');
    const placed = await e.applyOp(
      fx.projectId,
      {
        op: 'placeClip',
        args: {
          sequenceId: 'seq_a',
          trackId: 'V2',
          mediaId: 'm_used1',
          startMs: 2000,
          durationMs: 500,
        },
      } as never,
      { actor: 'cli' },
    );
    expect(placed.results[0]?.status).toBe('succeeded');
    const c = await e.credits(fx.projectId);
    expect(c).toEqual([
      {
        mediaId: 'm_used1',
        title: 'm_used1.jpg',
        author: 'Ana',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        url: 'https://commons.wikimedia.org/wiki/File:m_used1.jpg',
        attribution: '"m_used1" by Ana, CC BY-SA 4.0',
        sequenceIds: ['seq_a'],
      },
    ]);
  });
});

describe('preview (step 8b)', () => {
  test('compiles, writes the build and returns `npx hyperframes play <buildDir>` as an array', async () => {
    const r = await fx.e.preview(fx.projectId, 'seq_a');
    expect(r).toEqual({
      command: 'npx',
      args: ['hyperframes', 'play', join(fx.dir, 'build', 'seq_a')],
      buildDir: join(fx.dir, 'build', 'seq_a'),
      sequenceId: 'seq_a',
    });
    expect(readFileSync(join(r.buildDir, 'index.html'), 'utf8')).toContain('data-composition-id');
  });

  test('an unknown sequence fails NOT_FOUND with a hint', async () => {
    await expect(fx.e.preview(fx.projectId, 'seq_nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringMatching(/sequence id/),
    });
  });
});
