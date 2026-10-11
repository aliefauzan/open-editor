// Export targets and reveal (app spec "Testing": `exports.reveal`, export targets; plan D-13; R4 S32).
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayPath, ExportTargets, stubAnswer } from '../../src/main/exports.ts';
import { parseCall } from '../../src/shared/api.ts';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'vox-exp-'));
  const projectsDir = join(home, 'Projects');
  mkdirSync(join(projectsDir, 'p_abc', 'renders'), { recursive: true });
  const stateFile = join(home, '.vox', 'export-folders.json');
  const make = () => new ExportTargets({ stateFile, defaultFolder: join(home, 'Movies'), home });
  return { home, projectsDir, stateFile, make };
}

describe('export targets (D-13, S32)', () => {
  it('maps a session targetId to the engine target; file mode overwrites (the dialog asked)', () => {
    const { home, make } = setup();
    const t = make();
    const file = t.register('file', join(home, 'out', 'a.mp4'));
    const dir = t.register('folder', join(home, 'out'));
    expect(file.displayPath).toBe('~/out/a.mp4');
    expect(t.mapJobArgs({ projectId: 'p_abc', targetId: file.targetId })).toEqual({
      projectId: 'p_abc',
      target: { file: join(home, 'out', 'a.mp4') },
      overwrite: true,
    });
    expect(t.mapJobArgs({ projectId: 'p_abc', targetId: dir.targetId, format: 'srt' })).toEqual({
      projectId: 'p_abc',
      format: 'srt',
      target: { dir: join(home, 'out') },
    });
  });

  it('rejects an unknown targetId and one from a previous session', () => {
    const { home, make } = setup();
    const old = make().register('folder', join(home, 'out'));
    expect(() => make().mapJobArgs({ projectId: 'p_abc', targetId: old.targetId })).toThrow(
      /Unknown export target/,
    );
    expect(() => make().mapJobArgs({ projectId: 'p_abc', targetId: 't_nope' })).toThrow(
      expect.objectContaining({ code: 'EXPORT_TARGET' }),
    );
  });

  it('remembers the last folder per project across sessions (new targetId each time)', () => {
    const { home, stateFile, make } = setup();
    const a = make();
    expect(a.lastFolder('p_abc').displayPath).toBe('~/Movies');
    const pick = a.register('file', join(home, 'clips', 'x.mp4'));
    a.mapJobArgs({ projectId: 'p_abc', targetId: pick.targetId });
    const b = make();
    const last = b.lastFolder('p_abc');
    expect(last.displayPath).toBe('~/clips');
    expect(last.targetId).not.toBe(pick.targetId);
    expect(b.lastFolder('p_other').displayPath).toBe('~/Movies');
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ p_abc: join(home, 'clips') });
  });

  it('a cancelled dialog registers nothing, so the old target stays the one in use', () => {
    const { home, make } = setup();
    const t = make();
    const first = t.register('folder', join(home, 'a'));
    // cancel = no register call; the renderer keeps `first`
    expect(t.folderOf(first.targetId)).toBe(join(home, 'a'));
  });

  it('jobs.start rejects raw paths (path, file, dir, inputs, target) before main maps targets', () => {
    for (const k of ['path', 'file', 'dir', 'inputs', 'target', 'outDir', 'paths']) {
      const r = parseCall('jobs.start', ['render', { projectId: 'p_abc', [k]: '/tmp/x' }]);
      expect(r.ok, k).toBe(false);
    }
    expect(parseCall('jobs.start', ['render', { projectId: 'p_abc', targetId: 't_1' }]).ok).toBe(
      true,
    );
    expect(parseCall('jobs.start', ['assets.search', { projectId: 'p_abc', q: 'x' }]).ok).toBe(
      true,
    );
  });

  it('the dialog stub answers a folder, or the suggested file name inside it', () => {
    expect(stubAnswer('folder', '/tmp/e')).toBe('/tmp/e');
    expect(stubAnswer('file', '/tmp/e', 'P - Main.mp4')).toBe('/tmp/e/P - Main.mp4');
    expect(stubAnswer('file', '/tmp/e', '../../evil.mp4')).toBe('/tmp/e/evil.mp4');
  });

  it('displayPath shortens the home folder only', () => {
    expect(displayPath('/Users/u/Movies', '/Users/u')).toBe('~/Movies');
    expect(displayPath('/Users/uv/x', '/Users/u')).toBe('/Users/uv/x');
  });
});

describe('exports.reveal allow-list (app spec "Testing")', () => {
  it("accepts a path under a project's renders/ and a path written into this session's target", () => {
    const { home, projectsDir, make } = setup();
    const t = make();
    const render = join(projectsDir, 'p_abc', 'renders', 'Main.mp4');
    writeFileSync(render, '');
    expect(t.revealAllowed(render, projectsDir)).toBe(true);
    mkdirSync(join(home, 'out'));
    t.register('folder', join(home, 'out'));
    t.register('file', join(home, 'one.mp4'));
    expect(t.revealAllowed(join(home, 'out', 'Main (2).mp4'), projectsDir)).toBe(true);
    expect(t.revealAllowed(join(home, 'one.mp4'), projectsDir)).toBe(true);
  });

  it('rejects any other path', () => {
    const { home, projectsDir, make } = setup();
    const t = make();
    mkdirSync(join(home, 'out'));
    t.register('folder', join(home, 'out'));
    symlinkSync(home, join(projectsDir, 'p_abc', 'renders', 'link'));
    for (const bad of [
      join(projectsDir, 'p_abc', 'project.json'),
      join(projectsDir, 'p_abc', 'renders'),
      join(projectsDir, 'p_abc', 'renders', '..', 'project.json'),
      join(projectsDir, 'p_abc', 'renders', 'link', '.ssh', 'id_rsa'),
      join(home, 'out', 'sub', 'deeper.mp4'),
      join(home, 'elsewhere.mp4'),
      join(home, 'one.mp4'),
      'relative/renders/x.mp4',
      `${join(projectsDir, 'p_abc', 'renders')}/x\0.mp4`,
    ]) {
      expect(t.revealAllowed(bad, projectsDir), bad).toBe(false);
    }
  });
});
