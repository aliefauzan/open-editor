// Editor store (app spec "Live updates and editing flow", "Testing"; plan D-15): change records,
// optimistic ops, STALE rebase, linked selection, external reload, coalesced slider changes.
import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../../src/renderer/editor/store.ts';
import type { MediaClip, Project } from '../../src/shared/project.ts';
import { editorProject, op, tempEngine } from './engine-fixture.ts';
import { fakeVox } from './fake-vox.ts';

// updatedAt changes on every write and is not part of the change records
const strip = (p: Project | null) => p && { ...p, meta: { ...p.meta, updatedAt: '' } };

async function setup() {
  const engine = tempEngine();
  const p = await editorProject(engine);
  const fake = fakeVox(engine);
  const store = createEditorStore(fake.vox);
  await store.getState().open(p.id);
  const seq = () => store.getState().project!.sequences[0]!;
  const v1 = () => seq().videoTracks[0]!.items as MediaClip[];
  const a1 = () => seq().audioTracks[0]!.items as MediaClip[];
  const onDisk = async () => (await engine.getProject(p.id)) as unknown as Project;
  return { engine, p, fake, store, seq, v1, a1, onDisk };
}

describe('editor store', () => {
  it('opens a project and applies change records from project.changed', async () => {
    const { engine, p, fake, store, v1, onDisk } = await setup();
    expect(store.getState().version).toBe(p.version);
    // another actor (the agent) edits; the store follows through the event's change records
    await engine.applyOp(
      p.id,
      { op: 'moveItem', args: { sequenceId: 'seq_main', itemId: v1()[1]!.id, startMs: 10000 } },
      { actor: 'agent', runId: 'run_1' } as never,
    );
    await fake.settle();
    expect(strip(store.getState().project)).toEqual(strip(await onDisk()));
    expect(store.getState().version).toBe(p.version + 1);
    // agent changes carry a badge
    expect(store.getState().agentItems[v1().find((i) => i.startMs === 10000)!.id]).toBe('run_1');
  });

  it('applies an op optimistically, then confirms it with the engine result', async () => {
    const { fake, store, v1, a1, onDisk } = await setup();
    const id = v1()[1]!.id;
    const done = store.getState().apply({
      op: 'moveItem',
      args: { sequenceId: 'seq_main', itemId: id, startMs: 9000 },
    });
    // at once, before the engine answers: the clip and its linked audio moved
    expect(v1().find((i) => i.id === id)!.startMs).toBe(9000);
    expect(a1().map((i) => i.startMs)).toContain(9000);
    expect(store.getState().pending).toHaveLength(1);
    await done;
    await fake.settle();
    expect(store.getState().pending).toHaveLength(0);
    expect(strip(store.getState().project)).toEqual(strip(await onDisk()));
  });

  it('a failed op is reverted with a toast', async () => {
    const { fake, store, v1 } = await setup();
    const id = v1()[1]!.id;
    // onto the first clip: overlap error
    await store.getState().apply({
      op: 'moveItem',
      args: { sequenceId: 'seq_main', itemId: id, startMs: 1000 },
    });
    await fake.settle();
    expect(v1().find((i) => i.id === id)!.startMs).toBe(4000);
    expect(store.getState().toasts.map((t) => t.code)).toEqual(['OVERLAP']);
  });

  it('STALE: applies the newer changes and re-runs the intent once', async () => {
    const { engine, p, fake, store, v1, onDisk } = await setup();
    const scene = store.getState().project!.sequences[0]!.videoTracks[1]!.items[0]!;
    // a change the store has not seen yet (its event is lost on the way)
    fake.pauseEvents();
    await op(engine, p.id, 'moveItem', { sequenceId: 'seq_main', itemId: scene.id, startMs: 5000 });
    fake.dropEvents();
    fake.resumeEvents();
    const id = v1()[1]!.id;
    await store.getState().apply({
      op: 'moveItem',
      args: { sequenceId: 'seq_main', itemId: id, startMs: 12000 },
    });
    await fake.settle();
    const disk = await onDisk();
    expect(disk.sequences[0]!.videoTracks[0]!.items.find((i) => i.id === id)!.startMs).toBe(12000);
    expect(disk.sequences[0]!.videoTracks[1]!.items[0]!.startMs).toBe(5000);
    expect(strip(store.getState().project)).toEqual(strip(disk));
    expect(store.getState().toasts).toEqual([]);
    const sent = fake.calls.filter((c) => c.method === 'ops.apply');
    expect(sent).toHaveLength(2); // the STALE try and one retry
  });

  it('STALE: reverts with a toast when the rebased intent no longer applies', async () => {
    const { engine, p, fake, store, v1, onDisk } = await setup();
    const id = v1()[1]!.id;
    fake.pauseEvents();
    await op(engine, p.id, 'removeItem', { sequenceId: 'seq_main', itemId: id });
    fake.dropEvents();
    fake.resumeEvents();
    await store.getState().apply({
      op: 'moveItem',
      args: { sequenceId: 'seq_main', itemId: id, startMs: 12000 },
    });
    await fake.settle();
    expect(strip(store.getState().project)).toEqual(strip(await onDisk()));
    expect(v1().some((i) => i.id === id)).toBe(false);
    expect(store.getState().toasts).toHaveLength(1);
    expect(store.getState().toasts[0]!.message).toMatch(/changed/i);
  });

  it('linked selection: a click selects the linked pair, alt-click one item', async () => {
    const { store, v1, a1 } = await setup();
    const v = v1()[0]!;
    const a = a1().find((i) => i.linkId === v.linkId)!;
    store.getState().select(v.id);
    expect([...store.getState().selection].sort()).toEqual([v.id, a.id].sort());
    store.getState().select(v.id, { alt: true });
    expect(store.getState().selection).toEqual([v.id]);
    store.getState().select(v1()[1]!.id, { add: true, alt: true });
    expect(store.getState().selection).toHaveLength(2);
  });

  it('an external edit (actor external) reloads the whole project', async () => {
    const { engine, p, fake, store, onDisk } = await setup();
    // another process wrote project.json (vox op in a terminal); the engine host's watcher reads it
    // and the engine announces it as actor external
    const other = (await import('@vox/engine')).openEngine({
      projectsDir: engine.projectsDir,
      stylesDirs: engine.stylesDirs,
    });
    await op(other, p.id, 'updateSequence', { sequenceId: 'seq_main', name: 'Renamed' });
    const opens = () => fake.calls.filter((c) => c.method === 'projects.open').length;
    const before = opens();
    await engine.getProject(p.id); // what the watcher does
    await fake.settle();
    await store.getState().whenIdle();
    expect(opens()).toBe(before + 1);
    expect(strip(store.getState().project)).toEqual(strip(await onDisk()));
    expect(store.getState().project!.sequences[0]!.name).toBe('Renamed');
  });

  it('20 slider changes within 1 s carry one coalesceKey and make one history entry', async () => {
    const { engine, p, fake, store, v1 } = await setup();
    const id = v1()[0]!.id;
    const before = (await engine.history(p.id)).length;
    for (let i = 1; i <= 20; i++) {
      store.getState().setField('volume', id, {
        op: 'updateClip',
        args: { sequenceId: 'seq_main', itemId: id, volume: i / 20 },
      });
    }
    // the slider shows the last value at once
    expect(v1()[0]!.volume).toBe(1);
    await store.getState().whenIdle();
    await fake.settle();
    const sent = fake.calls.filter((c) => c.method === 'ops.apply');
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((c) => (c.args[0] as { coalesceKey?: string }).coalesceKey))).toEqual(
      new Set([`volume:${id}`]),
    );
    expect((await engine.history(p.id)).length).toBe(before + 1);
    expect(v1()[0]!.volume).toBe(1);
    // one undo restores the starting volume
    await store.getState().undo();
    await fake.settle();
    expect(v1()[0]!.volume).toBeUndefined();
  });

  it('undo and redo follow the engine', async () => {
    const { fake, store, v1, onDisk } = await setup();
    const id = v1()[1]!.id;
    await store.getState().apply({
      op: 'moveItem',
      args: { sequenceId: 'seq_main', itemId: id, startMs: 9000 },
    });
    await store.getState().undo();
    await fake.settle();
    expect(v1().find((i) => i.id === id)!.startMs).toBe(4000);
    await store.getState().redo();
    await fake.settle();
    expect(v1().find((i) => i.id === id)!.startMs).toBe(9000);
    expect(strip(store.getState().project)).toEqual(strip(await onDisk()));
  });
});
