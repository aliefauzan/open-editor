// Preview pipeline (app spec "Preview pipeline"; plan 10a step 2, D-15, D-29): in-memory compile
// after each change, scene-only → `patch` with the instance HTML, structural → `reload`; keyed
// (slider/typing) changes coalesce for 150 ms; VFR media play from the CFR copy.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '@vox/engine';
import { describe, expect, it, vi } from 'vitest';
import { COALESCE_MS, PreviewPipeline } from '../../src/engine-host/preview.ts';
import type { PreviewUpdated } from '../../src/shared/project.ts';
import { editorProject, op, tempEngine } from '../renderer/engine-fixture.ts';

// Compile only links media files, so a placeholder file is enough (no generated fixtures needed).
function place(dst: string) {
  mkdirSync(join(dst, '..'), { recursive: true });
  writeFileSync(dst, Buffer.alloc(1024));
}

async function setup(o: { coalesceMs?: number } = {}) {
  const engine = tempEngine();
  const p = await editorProject(engine);
  place(join(engine.projectsDir, p.id, 'media', 'v.mp4'));
  const events: PreviewUpdated[] = [];
  let compiles = 0;
  const counted: Engine = new Proxy(engine, {
    get(t, k, r) {
      if (k === 'compile') {
        return (...a: Parameters<Engine['compile']>) => {
          compiles++;
          return t.compile(...a);
        };
      }
      return Reflect.get(t, k, r) as unknown;
    },
  });
  const pipe = new PreviewPipeline(counted, (_n, e) => events.push(e as PreviewUpdated), o);
  const url = await pipe.open(p.id, 'seq_main');
  const scene = p.sequences[0]!.videoTracks[1]!.items[0]!;
  const clip = p.sequences[0]!.videoTracks[0]!.items[0]!;
  return { engine, p, pipe, url, events, scene, clip, compiles: () => compiles };
}

const until = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('preview pipeline', () => {
  it('open writes the build and returns its vox-media URL', async () => {
    const { engine, p, url } = await setup();
    expect(url).toBe(`vox-media://p/${p.id}/build/seq_main/index.html`);
    const html = readFileSync(
      join(engine.projectsDir, p.id, 'build', 'seq_main', 'index.html'),
      'utf8',
    );
    expect(html).toContain('Hello');
  });

  it('a scene-only change is a patch with the recompiled instance HTML', async () => {
    const { engine, p, pipe, events, scene } = await setup();
    pipe.noteOp(p.id);
    await op(engine, p.id, 'updateScene', {
      sequenceId: 'seq_main',
      itemId: scene.id,
      variables: { title: 'Patched title' },
    });
    await until(() => events.length === 1);
    const e = events[0]!;
    expect(e.kind).toBe('patch');
    if (e.kind !== 'patch') return;
    expect(e.patches).toHaveLength(1);
    expect(e.patches[0]).toMatchObject({ id: scene.id, start: 0, duration: 2 });
    expect(e.patches[0]!.html).toContain('Patched title');
    // the build on disk follows, so a later reload shows the same
    const html = readFileSync(
      join(engine.projectsDir, p.id, 'build', 'seq_main', 'index.html'),
      'utf8',
    );
    expect(html).toContain('Patched title');
    // a moved scene keeps the patch path, with its new timing
    await op(engine, p.id, 'moveItem', { sequenceId: 'seq_main', itemId: scene.id, startMs: 3000 });
    await until(() => events.length === 2);
    expect(events[1]).toMatchObject({ kind: 'patch', patches: [{ id: scene.id, start: 3 }] });
  });

  it('structural changes (media clips, tracks, captions, sequence) reload', async () => {
    const { engine, p, events, clip, url } = await setup();
    await op(engine, p.id, 'trimItem', {
      sequenceId: 'seq_main',
      itemId: clip.id,
      edge: 'end',
      toMs: 3000,
    });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ kind: 'reload', sequenceId: 'seq_main' });
    expect(events[0]!.kind === 'reload' && events[0]!.url.startsWith(url)).toBe(true);
    await op(engine, p.id, 'setCaptions', { sequenceId: 'seq_main', maxWords: 2 });
    await until(() => events.length === 2);
    expect(events[1]!.kind).toBe('reload');
    await op(engine, p.id, 'updateTrack', { sequenceId: 'seq_main', trackId: 'V2', hidden: true });
    await until(() => events.length === 3);
    expect(events[2]!.kind).toBe('reload');
  });

  it('adding or removing a scene reloads (the instance is new or gone)', async () => {
    const { engine, p, events, scene } = await setup();
    await op(engine, p.id, 'removeItem', { sequenceId: 'seq_main', itemId: scene.id });
    await until(() => events.length === 1);
    expect(events[0]!.kind).toBe('reload');
  });

  it('changes to another sequence or project do not rebuild', async () => {
    const { engine, p, events, compiles } = await setup();
    const n = compiles();
    await op(engine, p.id, 'addSequence', { name: 'Other', id: 'seq_other' });
    await op(engine, p.id, 'updateSequence', { sequenceId: 'seq_other', name: 'Other 2' });
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
    expect(compiles()).toBe(n);
  });

  it('keyed changes (slider, typing) coalesce for 150 ms; single ops do not wait', async () => {
    const { engine, p, pipe, events, scene, compiles } = await setup();
    expect(COALESCE_MS).toBe(150);
    // Only the pipeline's coalesce timer is faked, so the window opens and closes when the test
    // says, however slow the ops run on a loaded machine. The op path uses no global timers, and
    // `settled` polls with setImmediate, which stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const settled = async (cond: () => boolean, ms = 10_000) => {
        const t0 = Date.now();
        while (!cond()) {
          if (Date.now() - t0 > ms) throw new Error('timed out');
          await new Promise((r) => setImmediate(r));
        }
      };
      const n = compiles();
      for (let i = 0; i < 6; i++) {
        pipe.noteOp(p.id, `variables:${scene.id}`);
        await op(engine, p.id, 'updateScene', {
          sequenceId: 'seq_main',
          itemId: scene.id,
          variables: { title: `Typing ${i}` },
        });
      }
      // the burst waits for the window: one timer, nothing built until it closes
      expect(vi.getTimerCount()).toBe(1);
      expect(compiles() - n).toBe(0);
      vi.advanceTimersByTime(COALESCE_MS - 1);
      expect(compiles() - n).toBe(0);
      vi.advanceTimersByTime(1);
      await settled(() => events.length >= 1);
      // six keyed ops, one build, with the last value
      expect(compiles() - n).toBe(1);
      expect(events).toHaveLength(1);
      const last = events.at(-1)!;
      expect(last.kind === 'patch' && last.patches[0]!.html).toContain('Typing 5');
      // a single op: no debounce (no timer is scheduled, and it lands without advancing time)
      pipe.noteOp(p.id);
      const count = events.length;
      await op(engine, p.id, 'updateScene', {
        sequenceId: 'seq_main',
        itemId: scene.id,
        variables: { title: 'Single' },
      });
      expect(vi.getTimerCount()).toBe(0);
      await settled(() => events.length > count);
      const single = events.at(-1)!;
      expect(single.kind === 'patch' && single.patches[0]!.html).toContain('Single');
      expect(compiles() - n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a VFR clip plays from its CFR copy in the preview build (D-15)', async () => {
    const { engine, p, pipe, events } = await setup();
    const dir = join(engine.projectsDir, p.id);
    place(join(dir, 'media', 'phone.mp4'));
    place(join(dir, 'media', 'phone.cfr.mp4'));
    await op(engine, p.id, 'addMedia', {
      media: {
        id: 'm_phone',
        kind: 'video',
        path: 'media/phone.mp4',
        vfr: true,
        cfrPath: 'media/phone.cfr.mp4',
        durationMs: 20000,
        width: 1080,
        height: 1920,
        hasAudio: true,
        fps: { num: 30, den: 1 },
        origin: { type: 'upload' },
        tags: [],
      },
    });
    await op(engine, p.id, 'placeClip', {
      sequenceId: 'seq_main',
      trackId: 'V1',
      mediaId: 'm_phone',
      startMs: 8000,
      durationMs: 2000,
    });
    await until(() => events.some((e) => e.kind === 'reload'));
    const build = await engine.compile(p.id, 'seq_main', { mode: 'preview' });
    const linked = [...build.links].filter(([rel]) => rel.startsWith('media/m_phone'));
    expect(linked.length).toBeGreaterThan(0);
    for (const [, from] of linked) expect(from).toMatch(/phone\.cfr\.mp4$/);
    pipe.close();
  });
});

describe('preview pipeline: several scenes', () => {
  it('a change to two scenes at once reloads (one patch per delivery)', async () => {
    const engine = tempEngine();
    const p = await editorProject(engine);
    mkdirSync(join(engine.projectsDir, p.id, 'media'), { recursive: true });
    writeFileSync(join(engine.projectsDir, p.id, 'media', 'v.mp4'), Buffer.alloc(1024));
    await op(engine, p.id, 'addScene', {
      sequenceId: 'seq_main',
      trackId: 'V2',
      startMs: 5000,
      durationMs: 2000,
      template: 'base/title',
      variables: { title: 'Two' },
    });
    const events: PreviewUpdated[] = [];
    const pipe = new PreviewPipeline(engine, (_n, e) => events.push(e as PreviewUpdated));
    await pipe.open(p.id, 'seq_main');
    const scenes = (await engine.getProject(p.id)).sequences[0]!.videoTracks[1]!.items;
    await op(engine, p.id, 'batch', {
      ops: scenes.map((s) => ({
        op: 'updateScene',
        args: { sequenceId: 'seq_main', itemId: s.id, variables: { title: `New ${s.id}` } },
      })),
    });
    await until(() => events.length === 1);
    expect(events[0]!.kind).toBe('reload');
    pipe.close();
  });
});
