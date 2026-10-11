// Step 8: the engine host's window.vox handlers on a real engine (temp projects folder), and the
// MessagePort RPC between main and the engine host.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { openEngine } from '@vox/engine';
import { describe, expect, it } from 'vitest';
import { createHandlers, forwardEvents } from '../../src/engine-host/handlers.ts';
import { createClient, serve } from '../../src/engine-host/rpc.ts';

const STYLES = join(import.meta.dirname, '..', '..', '..', '..', 'styles');

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'vox-host-'));
  const engine = openEngine({
    projectsDir: join(home, 'Projects'),
    stylesDirs: [STYLES],
    trustFile: join(home, 'trust.json'),
  });
  return { engine, h: createHandlers(engine), home };
}

describe('engine host handlers (step 8)', () => {
  it('projects list/create/open, ops.apply with baseVersion + coalesceKey, STALE, per-op results', async () => {
    const { h } = setup();
    const p = (await h['projects.create']!('Demo')) as { id: string };
    expect(p.id).toMatch(/^p_/);
    expect(await h['projects.list']!()).toEqual([
      expect.objectContaining({ id: p.id, name: 'Demo' }),
    ]);
    expect(await h['projects.open']!(p.id)).toMatchObject({ project: { id: p.id }, version: 0 });
    const r = (await h['ops.apply']!({
      projectId: p.id,
      op: 'addSequence',
      args: { name: 'Main', id: 'seq_main' },
      baseVersion: 0,
      coalesceKey: 'name:seq_main',
    })) as { version: number; changes: unknown[]; results: { status: string }[] };
    expect(r.version).toBe(1);
    expect(r.results).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    expect(r.changes.length).toBeGreaterThan(0);
    // a stale baseVersion applies nothing; the op's result carries STALE (engine contract, D-28)
    const stale = (await h['ops.apply']!({
      projectId: p.id,
      op: 'addSequence',
      args: { name: 'B' },
      baseVersion: 0,
    })) as typeof r;
    expect(stale.version).toBe(1);
    expect(stale.changes).toEqual([]);
    expect(stale.results[0]).toMatchObject({ status: 'conflicted', error: { code: 'STALE' } });
  });

  it('preview.url compiles and writes the preview build, returns its vox-media URL', async () => {
    const { h, engine } = setup();
    const p = (await h['projects.create']!('Prev')) as { id: string };
    const run = (op: string, args: object, baseVersion: number) =>
      h['ops.apply']!({ projectId: p.id, op, args, baseVersion });
    await run('addSequence', { name: 'Main', id: 'seq_main' }, 0);
    await run(
      'addScene',
      {
        sequenceId: 'seq_main',
        trackId: 'V1',
        startMs: 0,
        durationMs: 2000,
        template: 'base/title',
        variables: { title: 'Hi' },
      },
      1,
    );
    const url = await h['preview.url']!(p.id, 'seq_main');
    expect(url).toBe(`vox-media://p/${p.id}/build/seq_main/index.html`);
    expect(existsSync(join(engine.projectsDir, p.id, 'build', 'seq_main', 'index.html'))).toBe(
      true,
    );
  });

  it('has no handler for later-phase or main-only methods (the RPC answers NOT_AVAILABLE)', () => {
    const { h } = setup();
    expect(h['agent.run']).toBeUndefined();
    expect(h['projects.reveal']).toBeUndefined();
    expect(h['media.importFiles']).toBeUndefined();
  });

  it('forwards project.changed events through the redactor', async () => {
    const { h, engine } = setup();
    const seen: [string, unknown][] = [];
    forwardEvents(engine, (name, payload) => seen.push([name, payload]));
    const p = (await h['projects.create']!('Ev')) as { id: string };
    await h['ops.apply']!({
      projectId: p.id,
      op: 'addSequence',
      args: { name: 'Main' },
      baseVersion: 0,
    });
    expect(seen).toContainEqual([
      'project.changed',
      expect.objectContaining({ projectId: p.id, version: 1 }),
    ]);
  });
});

describe('MessagePort RPC', () => {
  it('calls a handler and returns its value or its error data', async () => {
    const { port1, port2 } = new MessageChannel();
    serve(port2, {
      'projects.list': async () => [1, 2],
      'projects.open': async () => {
        throw Object.assign(new Error('nope'), { code: 'PROJECT_NOT_FOUND', hint: 'h' });
      },
    });
    const events: unknown[] = [];
    const c = createClient(port1, (name, payload) => events.push([name, payload]));
    expect(await c.call('projects.list', [])).toEqual([1, 2]);
    await expect(c.call('projects.open', ['p_x'])).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      message: 'nope',
      hint: 'h',
    });
    await expect(c.call('setup.status', [])).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    port2.postMessage({ event: 'project.changed', payload: { v: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([['project.changed', { v: 1 }]]);
    c.close(new Error('host exited'));
    port1.close();
  });

  it('rejects pending calls when the host goes away', async () => {
    const { port1 } = new MessageChannel();
    const c = createClient(port1, () => {});
    const pending = c.call('projects.list', []);
    c.close(Object.assign(new Error('host exited'), { code: 'HOST_UNAVAILABLE' }));
    await expect(pending).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    port1.close();
  });
});
