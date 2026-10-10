// Phase 02 CLI commands (plan step 16): new, op, undo, redo, history, snapshot, paths; --json and
// --projects-dir on every command; VoxError → exit 1 with the hint; usage errors → exit 2.
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { run } from '../src/main.ts';
import { spawnFileSync } from './spawn.ts';

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

function tmpProjects(): string {
  return join(mkdtempSync(join(tmpdir(), 'vox-cli-')), 'Projects');
}

async function vox(args: string[], env: Record<string, string | undefined> = {}): Promise<Out> {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: { HOME: '/nonexistent-home', ...env },
    cwd: process.cwd(),
  });
  return { code, stdout, stderr };
}

const json = (o: Out) => JSON.parse(o.stdout) as Record<string, unknown>;

async function newProject(dir: string, name = 'demo'): Promise<string> {
  const o = await vox(['new', name, '--json', '--projects-dir', dir]);
  expect(o.code, o.stderr).toBe(0);
  return json(o)['id'] as string;
}

describe('vox new', () => {
  test('creates a project with a 9:16 sequence added by one cli op', async () => {
    const dir = tmpProjects();
    const o = await vox(['new', 'demo', '--json', '--projects-dir', dir]);
    expect(o.code).toBe(0);
    const out = json(o);
    expect(out).toMatchObject({ name: 'demo', version: 1 });
    expect(out['id']).toMatch(/^p_[a-z0-9]+$/);
    expect(out['sequenceId']).toMatch(/^seq_/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const h = await vox(['history', out['id'] as string, '--json', '--projects-dir', dir]);
    const entries = JSON.parse(h.stdout) as {
      op: string;
      actor: string;
      changes: { after: { canvas?: unknown } }[];
    }[];
    expect(entries.map((e) => [e.op, e.actor])).toEqual([['addSequence', 'cli']]);
    const seq = entries[0]!.changes.find((c) => c.after.canvas)!.after;
    expect(seq).toMatchObject({ canvas: { width: 1080, height: 1920 }, styleId: 'base' });
  });

  test('text output names the project', async () => {
    const o = await vox(['new', 'demo', '--projects-dir', tmpProjects()]);
    expect(o.stdout).toMatch(/demo \(p_[a-z0-9]+\)/);
  });

  test('VOX_PROJECTS_DIR is used when no flag is given', async () => {
    const dir = tmpProjects();
    const o = await vox(['new', 'demo', '--json'], { VOX_PROJECTS_DIR: dir });
    expect(statSync(join(dir, json(o)['id'] as string)).isDirectory()).toBe(true);
  });
});

describe('vox op / undo / redo', () => {
  test('applies an op by project name, undoes and redoes it', async () => {
    const dir = tmpProjects();
    const id = await newProject(dir, 'clip');
    const h = JSON.parse((await vox(['history', id, '--json', '--projects-dir', dir])).stdout);
    const seqId = h[0].changes[0].after.id as string;
    const o = await vox([
      'op',
      'clip',
      'updateSequence',
      JSON.stringify({ sequenceId: seqId, name: 'X' }),
      '--json',
      '--projects-dir',
      dir,
    ]);
    expect(o.code, o.stderr).toBe(0);
    expect(json(o)).toMatchObject({
      version: 2,
      results: [{ op: 'updateSequence', status: 'succeeded' }],
    });
    const u = await vox(['undo', id, '--json', '--projects-dir', dir]);
    expect(json(u)).toMatchObject({ version: 3, results: [{ op: 'undo' }] });
    const r = await vox(['redo', id, '--projects-dir', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/version 4/);
    const entries = JSON.parse(
      (await vox(['history', id, '--json', '--projects-dir', dir, '--since', '2'])).stdout,
    );
    expect(entries.map((e: { kind: string }) => e.kind)).toEqual(['undo', 'redo']);
  });

  test('a failed op exits 1 and prints the hint; --json prints the error object', async () => {
    const dir = tmpProjects();
    const id = await newProject(dir);
    const t = await vox([
      'op',
      id,
      'removeItem',
      '{"sequenceId":"seq_x","itemId":"it_x"}',
      '--projects-dir',
      dir,
    ]);
    expect(t.code).toBe(1);
    expect(t.stderr).toMatch(/hint: /);
    const j = await vox([
      'op',
      id,
      'removeItem',
      '{"sequenceId":"seq_x","itemId":"it_x"}',
      '--json',
      '--projects-dir',
      dir,
    ]);
    expect(j.code).toBe(1);
    expect(json(j)).toMatchObject({
      version: 1,
      results: [{ status: 'failed', error: { code: 'NOT_FOUND', hint: expect.any(String) } }],
    });
  });

  test('nothing to undo is exit 1 with NOTHING_TO_UNDO', async () => {
    const dir = tmpProjects();
    const id = await newProject(dir);
    await vox(['undo', id, '--projects-dir', dir]);
    const o = await vox(['undo', id, '--json', '--projects-dir', dir]);
    expect(o.code).toBe(1);
    expect(json(o)).toMatchObject({ error: { code: 'NOTHING_TO_UNDO' } });
  });

  test('an ambiguous name is PROJECT_AMBIGUOUS listing the ids; an unknown one PROJECT_NOT_FOUND', async () => {
    const dir = tmpProjects();
    const a = await newProject(dir, 'same');
    const b = await newProject(dir, 'same');
    const o = await vox(['undo', 'same', '--json', '--projects-dir', dir]);
    expect(o.code).toBe(1);
    expect(json(o)).toMatchObject({
      error: { code: 'PROJECT_AMBIGUOUS', details: { ids: [a, b].sort() } },
    });
    const n = await vox(['undo', 'nope', '--json', '--projects-dir', dir]);
    expect(json(n)).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
  });

  test('invalid args JSON and unknown commands are usage errors (exit 2)', async () => {
    const dir = tmpProjects();
    const id = await newProject(dir);
    expect((await vox(['op', id, 'addTrack', '{bad', '--projects-dir', dir])).code).toBe(2);
    expect((await vox(['frobnicate'])).code).toBe(2);
    expect((await vox(['op'])).code).toBe(2);
    expect((await vox(['new', 'x', '--bogus'])).code).toBe(2);
  });

  test('--actor external is refused: only the engine records external changes', async () => {
    const dir = tmpProjects();
    const id = await newProject(dir);
    const o = await vox(['op', id, 'addTrack', '{}', '--actor', 'external', '--projects-dir', dir]);
    expect(o.code).toBe(2);
  });

  test('text output strips terminal control characters from project data', async () => {
    const dir = tmpProjects();
    const o = await vox(['new', 'evil\u001b]0;pwned\u0007name', '--projects-dir', dir]);
    expect(o.code).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(o.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(o.stdout).toMatch(/evil.*name/);
  });

  test('vox undo --run <runId> undoes an agent run', async () => {
    const dir = tmpProjects();
    const id = await newProject(dir);
    const o = await vox(['undo', id, '--run', 'run_x', '--json', '--projects-dir', dir]);
    expect(json(o)).toMatchObject({ error: { code: 'NOTHING_TO_UNDO' } });
  });
});

describe('vox snapshot', () => {
  test('saves and lists snapshots', async () => {
    const dir = tmpProjects();
    const id = await newProject(dir);
    expect((await vox(['snapshot', id, 'before', '--projects-dir', dir])).code).toBe(0);
    const l = await vox(['snapshot', id, '--list', '--json', '--projects-dir', dir]);
    expect(JSON.parse(l.stdout)).toEqual([{ name: 'before', version: 1 }]);
    const again = await vox(['snapshot', id, 'before', '--json', '--projects-dir', dir]);
    expect(again.code).toBe(1);
    expect(json(again)).toMatchObject({ error: { code: 'SNAPSHOT_EXISTS' } });
  });
});

describe('vox paths', () => {
  test('--json prints the resolved projects folder (flag > env), styles folders and tools', async () => {
    const env = { VOX_PROJECTS_DIR: '/tmp/vox-env-projects' };
    const fromEnv = json(await vox(['paths', '--json'], env));
    expect(fromEnv['projectsDir']).toBe('/tmp/vox-env-projects');
    const fromFlag = json(await vox(['paths', '--json', '--projects-dir', '/tmp/vox-flag'], env));
    expect(fromFlag['projectsDir']).toBe('/tmp/vox-flag');
    expect(Array.isArray(fromFlag['stylesDirs'])).toBe(true);
    expect((fromFlag['stylesDirs'] as string[]).at(-1)).toBe('/nonexistent-home/.vox/styles');
    expect(fromFlag['tools']).toMatchObject({ dir: expect.stringContaining('Vox Studio/tools') });
  });

  test('the bin runs async commands and sets the exit code', () => {
    const dir = tmpProjects();
    const out = spawnFileSync(['paths', '--json', '--projects-dir', dir]);
    expect(JSON.parse(out).projectsDir).toBe(dir);
  });
});
