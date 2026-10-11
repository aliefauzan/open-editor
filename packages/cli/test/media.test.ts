// Phase 04 CLI: config projectsDir, ingest (relative paths against the cwd, actor cli),
// media-frames usage, doctor (--json never prompts; a terminal run asks once and saves `contact`;
// `vox doctor <project> --unlock`).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { run, type Io } from '../src/main.ts';

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

const tmp = (p = 'vox-cli-media-') => mkdtempSync(join(tmpdir(), p));

async function vox(
  args: string[],
  env: Record<string, string | undefined>,
  more: Partial<Io> = {},
): Promise<Out> {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { HOME: '/nonexistent-home', PATH: process.env['PATH'], ...env },
    cwd: process.cwd(),
    ...more,
  });
  return { code, stdout, stderr };
}

describe('config projectsDir', () => {
  test('is used when no flag or env is set (D-10)', async () => {
    const home = tmp();
    const projects = join(tmp(), 'FromConfig');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ projectsDir: projects }));
    const o = await vox(['new', 'demo', '--json'], { VOX_HOME: home });
    expect(o.code, o.stderr).toBe(0);
    const id = (JSON.parse(o.stdout) as { id: string }).id;
    expect(existsSync(join(projects, id, 'project.json'))).toBe(true);
    // A flag still wins.
    const flag = join(tmp(), 'Flag');
    const o2 = await vox(['new', 'demo', '--json', '--projects-dir', flag], { VOX_HOME: home });
    expect(existsSync(join(flag, (JSON.parse(o2.stdout) as { id: string }).id))).toBe(true);
  });
});

describe('vox ingest', () => {
  test('a relative path is resolved against the current folder; the entry is by cli', async () => {
    const home = tmp();
    const projects = join(tmp(), 'Projects');
    const env = { VOX_HOME: home };
    const p = await vox(['new', 'demo', '--json', '--projects-dir', projects], env);
    const id = (JSON.parse(p.stdout) as { id: string }).id;
    const cwd = tmp();
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'docs', 'script.txt'), 'hello\n');
    const o = await vox(
      ['ingest', id, 'docs/script.txt', '--json', '--projects-dir', projects],
      env,
      { cwd },
    );
    expect(o.code, o.stderr + o.stdout).toBe(0);
    const r = JSON.parse(o.stdout) as { media: { input: string; kind: string }[] };
    expect(r.media[0]).toMatchObject({ input: join(cwd, 'docs', 'script.txt'), kind: 'document' });
    const h = await vox(['history', id, '--json', '--projects-dir', projects], env);
    expect((JSON.parse(h.stdout) as { actor: string; op: string }[]).at(-1)).toMatchObject({
      actor: 'cli',
      op: 'addMedia',
    });
  });

  test('a non-http link is URL_INVALID (exit 1)', async () => {
    const projects = join(tmp(), 'Projects');
    const env = { VOX_HOME: tmp() };
    const p = await vox(['new', 'demo', '--json', '--projects-dir', projects], env);
    const id = (JSON.parse(p.stdout) as { id: string }).id;
    const o = await vox(
      ['ingest', id, 'ftp://example.com/a.mp4', '--json', '--projects-dir', projects],
      env,
    );
    expect(o.code).toBe(1);
    expect(JSON.parse(o.stdout)).toMatchObject({ error: { code: 'URL_INVALID' } });
  });

  test('media-frames needs --at-ms (usage error, exit 2)', async () => {
    const o = await vox(['media-frames', 'p_x', 'm_x', '--at-ms', 'soon'], { VOX_HOME: tmp() });
    expect(o.code).toBe(2);
  });
});

describe('vox doctor', () => {
  test('--json never prompts and reports a missing contact', async () => {
    const home = tmp();
    const o = await vox(
      ['doctor', '--json', '--quick'],
      { VOX_HOME: home },
      {
        isTTY: true,
        prompt: async () => {
          throw new Error('must not prompt');
        },
      },
    );
    const r = JSON.parse(o.stdout) as { checks: { name: string; level: string }[] };
    expect(r.checks.find((c) => c.name === 'contact')).toMatchObject({ level: 'warn' });
    expect(r.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['ffmpeg', 'yt-dlp', 'uv', 'model-silero-vad']),
    );
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  test('a terminal run asks once and saves the contact with writeConfig (other keys kept)', async () => {
    const home = tmp();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ limits: { maxStepsPerRun: 7 } }));
    let asked = 0;
    const io = { isTTY: true, prompt: async () => (asked++, 'editor@example.org') };
    await vox(['doctor', '--quick'], { VOX_HOME: home }, io);
    await vox(['doctor', '--quick'], { VOX_HOME: home }, io);
    expect(asked).toBe(1);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({
      limits: { maxStepsPerRun: 7 },
      contact: 'editor@example.org',
    });
  });

  test('doctor <project> --unlock removes a lock', async () => {
    const projects = join(tmp(), 'Projects');
    const env = { VOX_HOME: tmp() };
    const p = await vox(['new', 'demo', '--json', '--projects-dir', projects], env);
    const id = (JSON.parse(p.stdout) as { id: string }).id;
    writeFileSync(
      join(projects, id, 'project.lock'),
      JSON.stringify({ pid: 1, host: 'other-mac', startedAt: 'x' }),
    );
    const o = await vox(
      ['doctor', id, '--json', '--quick', '--unlock', '--projects-dir', projects],
      env,
    );
    expect(JSON.parse(o.stdout)).toMatchObject({
      project: { lock: { host: 'other-mac', removed: true } },
    });
    expect(existsSync(join(projects, id, 'project.lock'))).toBe(false);
  });
});
