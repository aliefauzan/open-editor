// External edits: another process writes project.json → the engine host's watcher makes the engine
// announce `project.changed { actor: 'external' }` (app spec "Live updates" step 5).
import { join } from 'node:path';
import { openEngine } from '@vox/engine';
import { describe, expect, it } from 'vitest';
import { watchProject } from '../../src/engine-host/watch.ts';
import { editorProject, op, tempEngine } from '../renderer/engine-fixture.ts';

describe('project watcher', () => {
  it("another process's write is announced as an external change; own writes are not", async () => {
    const engine = tempEngine();
    const p = await editorProject(engine);
    const seen: { actor: string; version: number }[] = [];
    engine.on('project.changed', (e) => seen.push({ actor: e.actor, version: e.version }));
    const stop = watchProject(engine, p.id, join(engine.projectsDir, p.id), { debounceMs: 20 });
    try {
      await op(engine, p.id, 'updateSequence', { sequenceId: 'seq_main', name: 'Own' });
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.map((s) => s.actor)).toEqual(['user']);
      const cli = openEngine({ projectsDir: engine.projectsDir, stylesDirs: engine.stylesDirs });
      await cli.applyOp(
        p.id,
        { op: 'updateSequence', args: { sequenceId: 'seq_main', name: 'From the CLI' } } as never,
        { actor: 'cli' },
      );
      for (let i = 0; i < 200 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
      expect(seen.at(-1)).toMatchObject({ actor: 'external', version: p.version + 2 });
    } finally {
      stop();
    }
  });
});
