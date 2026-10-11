// Library API (engine spec "Library API"): projects, applyOp, view, undo/redo/undoRun, history,
// snapshots and the project.changed event.
import { cpSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, SCHEMA_VERSION, version, type ProjectChangedEvent } from '../src/api.ts';
import { tempDir } from './helpers/store.ts';
import { templates } from './helpers/templates.ts';

const engine = () =>
  openEngine({ projectsDir: join(tempDir('vox-api-'), 'Projects'), stylesDirs: [], templates });

const addSeq = { op: 'addSequence', args: { name: 'Main', id: 'seq_main' } };

describe('engine api', () => {
  test('exports the package version as a semver string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('createProject writes version 0 with no sequence, an empty history, folder mode 0700', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    expect(p).toMatchObject({
      name: 'demo',
      version: 0,
      sequences: [],
      media: [],
      schemaVersion: SCHEMA_VERSION,
    });
    expect(p.id).toMatch(/^p_[a-z0-9]+$/);
    const dir = join(e.projectsDir, p.id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(e.projectsDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'history.jsonl')).size).toBe(0);
    expect(await e.getProject(p.id)).toEqual(p);
  });

  test('listProjects lists id, name, version and updatedAt', async () => {
    const e = engine();
    expect(await e.listProjects()).toEqual([]);
    const a = await e.createProject('a');
    const b = await e.createProject('b');
    await e.applyOp(b.id, addSeq, { actor: 'cli' });
    const list = await e.listProjects();
    expect(list.map((x) => [x.id, x.name, x.version])).toEqual(
      [
        [a.id, 'a', 0],
        [b.id, 'b', 1],
      ].sort(),
    );
    expect(typeof list[0]!.updatedAt).toBe('string');
  });

  test('applyOp, undo, redo, history and the project.changed event', async () => {
    const e = engine();
    const events: ProjectChangedEvent[] = [];
    const off = e.on('project.changed', (ev) => events.push(ev));
    const p = await e.createProject('demo');
    const r = await e.applyOp(p.id, addSeq, { actor: 'cli' });
    expect(r).toMatchObject({
      version: 1,
      results: [{ op: 'addSequence', status: 'succeeded', report: { sequenceId: 'seq_main' } }],
    });
    await e.undo(p.id);
    expect((await e.getProject(p.id)).sequences).toEqual([]);
    await e.redo(p.id);
    expect((await e.getProject(p.id)).sequences.map((s) => s.id)).toEqual(['seq_main']);
    expect((await e.history(p.id)).map((h) => h.kind)).toEqual(['op', 'undo', 'redo']);
    expect((await e.history(p.id, { sinceVersion: 2 })).map((h) => h.version)).toEqual([3]);
    expect(events.map((x) => [x.version, x.op, x.actor])).toEqual([
      [1, 'addSequence', 'cli'],
      [2, 'undo', 'user'],
      [3, 'redo', 'user'],
    ]);
    off();
    await e.undo(p.id);
    expect(events).toHaveLength(3);
  });

  test('undoRun reverts an agent run', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    await e.applyOp(p.id, addSeq, { actor: 'cli' });
    await e.applyOp(
      p.id,
      { op: 'updateSequence', args: { sequenceId: 'seq_main', name: 'x' } },
      { actor: 'agent', runId: 'run_1' },
    );
    await e.undoRun(p.id, 'run_1');
    expect((await e.getProject(p.id)).sequences[0]!.name).toBe('Main');
  });

  test('undoRun with last undoes only the run’s newest entry, past a later user edit', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    await e.applyOp(p.id, addSeq, { actor: 'cli' });
    await e.applyOp(
      p.id,
      { op: 'addSequence', args: { name: 'B', id: 'seq_b' } },
      { actor: 'cli' },
    );
    const rename = (sequenceId: string, name: string) => ({
      op: 'updateSequence',
      args: { sequenceId, name },
    });
    await e.applyOp(p.id, rename('seq_main', 'one'), { actor: 'agent', runId: 'run_1' });
    await e.applyOp(p.id, rename('seq_main', 'two'), { actor: 'agent', runId: 'run_1' });
    await e.applyOp(p.id, rename('seq_b', 'user'), { actor: 'user' });
    const r = await e.undoRun(p.id, 'run_1', { actor: 'agent', runId: 'run_1', last: true });
    expect(r.results[0]?.status).toBe('succeeded');
    const names = (await e.getProject(p.id)).sequences.map((s) => s.name).sort();
    expect(names).toEqual(['one', 'user']);
    // its keys changed since: the user renames seq_main, then the agent's next "last" undo conflicts
    await e.applyOp(p.id, rename('seq_main', 'mine'), { actor: 'user' });
    await expect(
      e.undoRun(p.id, 'run_1', { actor: 'agent', runId: 'run_1', last: true }),
    ).rejects.toMatchObject({ code: 'UNDO_CONFLICT' });
  });

  test('snapshot and listSnapshots', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    await e.snapshot(p.id, 'empty');
    expect(await e.listSnapshots(p.id)).toEqual([{ name: 'empty', version: 0 }]);
  });

  test('getProject sees a write made through another engine (another process)', async () => {
    const e1 = engine();
    const p = await e1.createProject('demo');
    await e1.getProject(p.id);
    const e2 = openEngine({ projectsDir: e1.projectsDir, stylesDirs: [] });
    await e2.applyOp(p.id, addSeq, { actor: 'cli' });
    expect((await e1.getProject(p.id)).version).toBe(1);
  });

  test('deleteProject removes the folder; unknown ids are PROJECT_NOT_FOUND', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    await e.deleteProject(p.id);
    expect(existsSync(join(e.projectsDir, p.id))).toBe(false);
    await expect(e.getProject(p.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(e.deleteProject(p.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(e.getProject('../etc')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  test('a project folder that is a symlink is refused', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    symlinkSync(join(e.projectsDir, p.id), join(e.projectsDir, 'p_link'));
    await expect(
      openEngine({ projectsDir: e.projectsDir, stylesDirs: [] }).getProject('p_link'),
    ).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });

  test('a project whose id differs from its folder name is refused', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    cpSync(join(e.projectsDir, p.id), join(e.projectsDir, 'p_copy'), { recursive: true });
    await expect(e.getProject('p_copy')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('view (SequenceView)', () => {
  test('a flat, sorted item list with kind, mediaId or template/text, and the version', async () => {
    const e = engine();
    const p = await e.createProject('demo');
    const media = {
      id: 'm_cam',
      kind: 'video',
      path: 'media/m_cam.mp4',
      durationMs: 10000,
      width: 1920,
      height: 1080,
      hasAudio: true,
      fps: { num: 30, den: 1 },
      origin: { type: 'upload' },
      tags: [],
    };
    const ops = [
      { op: 'addMedia', args: { media } },
      addSeq,
      {
        op: 'placeClip',
        args: {
          sequenceId: 'seq_main',
          trackId: 'V1',
          mediaId: 'm_cam',
          startMs: 0,
          durationMs: 4000,
        },
      },
      {
        op: 'addScene',
        args: {
          sequenceId: 'seq_main',
          trackId: 'V2',
          startMs: 1000,
          durationMs: 2000,
          template: 'test/title',
          variables: { title: 'Hello' },
        },
      },
    ];
    const r = await e.applyOp(p.id, { op: 'batch', args: { ops } }, { actor: 'cli' });
    const [, , placed, added] = r.results.map(
      (x) => (x.report as { itemIds?: string[] } | undefined)?.itemIds,
    );
    expect(await e.view(p.id, 'seq_main')).toEqual({
      version: 1,
      items: [
        { id: placed![0], track: 'V1', startMs: 0, endMs: 4000, kind: 'video', mediaId: 'm_cam' },
        { id: placed![1], track: 'A1', startMs: 0, endMs: 4000, kind: 'audio', mediaId: 'm_cam' },
        {
          id: added![0],
          track: 'V2',
          startMs: 1000,
          endMs: 3000,
          kind: 'scene',
          template: 'test/title',
          text: 'Hello',
        },
      ],
      captions: [],
    });
    await expect(e.view(p.id, 'seq_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
