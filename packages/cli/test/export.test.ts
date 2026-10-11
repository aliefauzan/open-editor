// Phase 05 CLI: render / export-captions / export-timeline targets (-o, --out-dir, --overwrite),
// compile, preview (spawn spy: `npx hyperframes play <buildDir>`, no browser), credits,
// assets generate without a provider, and the usage errors of the new flags. HyperFrames is replaced
// by an ffmpeg test pattern through the `engine` test seam; the real renders are engine slow tests.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openEngine, type HyperframesRun } from '@vox/engine';
import { run, type Io } from '../src/main.ts';

const FX = fileURLToPath(new URL('../../engine/test/fixtures/', import.meta.url));
const STYLES = fileURLToPath(new URL('../../../styles', import.meta.url));

const tmp = (p = 'vox-cli-export-') => mkdtempSync(join(tmpdir(), p));

const fakeHf: HyperframesRun = async (args) => {
  const out = args[args.indexOf('-o') + 1]!;
  const html = readFileSync(join(args[1]!, 'index.html'), 'utf8');
  const dur = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? '1');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=30:duration=${dur}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  ]); // prettier-ignore
};

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

let projects: string;
let projectId: string;
const spawned: { command: string; args: readonly string[]; cwd: string }[] = [];

async function vox(args: string[], more: Partial<Io> = {}): Promise<Out> {
  let stdout = '';
  let stderr = '';
  const code = await run([...args, '--projects-dir', projects], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { HOME: '/nonexistent-home', VOX_HOME: tmp('vox-cli-home-'), PATH: process.env['PATH'] },
    cwd: tmp('vox-cli-cwd-'),
    engine: { hyperframes: fakeHf },
    spawn: async (command, a, o) => {
      spawned.push({ command, args: a, cwd: o.cwd });
      return 0;
    },
    ...more,
  });
  return { code, stdout, stderr };
}

/** Project "Cli": the talking-head fixture with its transcript, a 2 s linked clip, a title, captions. */
beforeAll(async () => {
  projects = join(tmp(), 'Projects');
  const e = openEngine({ projectsDir: projects, stylesDirs: [STYLES], config: async () => ({}) });
  const p = await e.createProject('Cli');
  projectId = p.id;
  const dir = join(projects, p.id);
  await mkdir(join(dir, 'media'), { recursive: true });
  await mkdir(join(dir, 'transcripts'), { recursive: true });
  await copyFile(
    join(FX, 'assets', 'media', 'talking-head-20s.mp4'),
    join(dir, 'media', 'm_head.mp4'),
  );
  await copyFile(
    join(FX, 'transcripts', 'talking-head-20s.json'),
    join(dir, 'transcripts', 'm_head.json'),
  );
  const media = {
    id: 'm_head',
    kind: 'video',
    path: 'media/m_head.mp4',
    durationMs: 20000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    fps: { num: 30, den: 1 },
    transcriptPath: 'transcripts/m_head.json',
    transcriptRev: 'r1',
    origin: { type: 'upload' },
    tags: [],
  };
  const r = await e.applyOp(
    p.id,
    {
      op: 'batch',
      args: {
        ops: [
          { op: 'addMedia', args: { media } },
          { op: 'addSequence', args: { name: 'Main', id: 'seq_a', styleId: 'base' } },
          {
            op: 'placeClip',
            args: {
              sequenceId: 'seq_a',
              trackId: 'V1',
              mediaId: 'm_head',
              startMs: 0,
              durationMs: 2000,
              withAudio: true,
            },
          },
          {
            op: 'addScene',
            args: {
              sequenceId: 'seq_a',
              trackId: 'V2',
              startMs: 500,
              durationMs: 1000,
              template: 'base/title',
              variables: { title: 'Hi' },
            },
          },
          { op: 'setCaptions', args: { sequenceId: 'seq_a', enabled: true } },
        ],
      },
    } as never,
    { actor: 'cli' },
  );
  expect(
    r.results.every((x) => x.status === 'succeeded'),
    JSON.stringify(r.results),
  ).toBe(true);
}, 60_000);

describe('vox render / export-* targets', () => {
  test('render -o writes the file; a second run needs --overwrite', async () => {
    const out = join(tmp(), 'a.mp4');
    const r = await vox(['render', projectId, '-o', out, '--quality', 'draft', '--json']);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const res = JSON.parse(r.stdout) as { files: { path: string }[]; quality: string };
    expect(res.files[0]!.path).toBe(out);
    expect(res.quality).toBe('draft');
    expect(existsSync(out)).toBe(true);
    const again = await vox(['render', projectId, '-o', out, '--json']);
    expect(again.code).toBe(1);
    expect((JSON.parse(again.stdout) as { error: { code: string } }).error.code).toBe(
      'EXPORT_PATH',
    );
    expect((await vox(['render', projectId, '-o', out, '--overwrite'])).code).toBe(0);
  }, 60_000);

  test('render --out-dir twice gives "(2)"; --range-ms and --captions none pass through', async () => {
    const dir = tmp();
    const a = await vox([
      'render',
      projectId,
      '--out-dir',
      dir,
      '--range-ms',
      '0-1000',
      '--captions',
      'none',
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(a.stdout).toMatch(/Cli-Main\.mp4\t1000 ms\n$/);
    const b = await vox(['render', projectId, '--out-dir', dir, '--json']);
    expect((JSON.parse(b.stdout) as { files: { path: string }[] }).files[0]!.path).toBe(
      join(dir, 'Cli-Main (2).mp4'),
    );
  }, 60_000);

  test('export-captions -o writes SRT and VTT; --format is required', async () => {
    const dir = tmp();
    const srt = await vox([
      'export-captions',
      projectId,
      '--format',
      'srt',
      '-o',
      join(dir, 'c.srt'),
    ]);
    expect(srt.code, srt.stderr).toBe(0);
    expect(readFileSync(join(dir, 'c.srt'), 'utf8')).toMatch(/^1\n00:00:00,\d{3} --> /);
    const vtt = await vox(['export-captions', projectId, '--format', 'vtt', '--out-dir', dir]);
    expect(vtt.stdout.trim()).toBe(join(dir, 'Cli-Main.vtt'));
    expect(readFileSync(join(dir, 'Cli-Main.vtt'), 'utf8')).toMatch(/^WEBVTT/);
    expect((await vox(['export-captions', projectId])).code).toBe(2);
  });

  test('usage errors exit 2', async () => {
    for (const args of [
      ['render', projectId, '--quality', 'looks'],
      ['render', projectId, '--loudness', 'loud'],
      ['render', projectId, '--range-ms', '5-1'],
      ['render', projectId, '-o', '/tmp/x.mp4', '--out-dir', '/tmp'],
      ['render', projectId, '--all', '--seq', 'seq_a'],
      ['frames', projectId, '--at-ms', '1.5'],
      ['compile', projectId, '--mode', 'final'],
      ['audio-qa', projectId, '--loudness', 'radio'],
      ['quick', '/tmp/x.mp4', '--out-dir', '/tmp'],
      ['quick', '/tmp/x.mp4', '--length', '8-4'],
      ['assets', 'resize', projectId, 'm_head'],
    ]) {
      const r = await vox(args);
      expect(r.code, args.join(' ')).toBe(2);
    }
  });
});

describe('vox compile / preview / credits / assets generate', () => {
  test('compile writes build/<seq>/', async () => {
    const r = await vox(['compile', projectId, '--json']);
    expect(r.code, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout) as { buildDir: string; sequenceId: string; mode: string };
    expect(res).toMatchObject({ sequenceId: 'seq_a', mode: 'preview' });
    expect(existsSync(join(res.buildDir, 'index.html'))).toBe(true);
  });

  test('preview spawns npx hyperframes play <buildDir> with an argument array', async () => {
    spawned.length = 0;
    const r = await vox(['preview', projectId, '--seq', 'seq_a']);
    expect(r.code, r.stderr).toBe(0);
    expect(spawned).toHaveLength(1);
    const s = spawned[0]!;
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['hyperframes', 'play', s.cwd]);
    expect(readdirSync(s.cwd)).toContain('index.html');
    const bad = await vox(['preview', projectId, '--seq', 'seq_nope']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/hint: /);
    expect(spawned).toHaveLength(1);
  });

  test('audio-qa on a sequence prints the checks and writes qa.json, qa.png, LISTEN.md', async () => {
    const r = await vox(['audio-qa', projectId, '--seq', 'seq_a']);
    expect(r.code, r.stderr).toBeLessThanOrEqual(1);
    expect(r.stderr).not.toMatch(/TypeError/);
    const outDir = r.stdout.trim().split('\n').at(-1)!;
    for (const f of ['qa.json', 'qa.png', 'LISTEN.md'])
      expect(existsSync(join(outDir, f)), f).toBe(true);
    expect(r.stdout).toMatch(/^(PASS|FAIL|WARN|SKIP)\s*\t\S+/m);
  }, 120_000);

  test('credits with no archive media; assets generate without a provider fails with a hint', async () => {
    const c = await vox(['credits', projectId]);
    expect(c.stdout).toBe('no archive assets used\n');
    const g = await vox(['assets', 'generate', projectId, 'a red fox', '--json']);
    expect(g.code).toBe(1);
    const err = (JSON.parse(g.stdout) as { error: { code: string; hint: string } }).error;
    expect(err.code).toBe('PROVIDER_MISSING');
    expect(err.hint).toMatch(/vox assets search/);
  });
});
