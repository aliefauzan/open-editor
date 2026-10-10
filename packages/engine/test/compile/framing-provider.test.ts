// Facetrack path provider (phase 05 step 9b, moved from 04): the engine's compile plugs 04's path
// builder into 03's framing interface. A `facetrack` and an `auto` clip on the seeded talking-head
// media compile to the same transform keyframes as the builder's own output (applied to the clip
// window), a clip without a facetrack keeps its static crop, and a changed `stability` recompiles
// to a different path. The cuts-2shot run with real detection is `framing-provider.local.test.ts`.
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, type Engine, type FramingProvider } from '../../src/api.ts';
import type { Frame } from '../../src/model/schema.ts';
import { applyClipFraming, trackOptionsFromFrame } from '../../src/stages/facetrack.ts';
import { tempDir } from '../helpers/store.ts';
import { HEAD, REPO_STYLES } from '../export/project.ts';

const FX = join(import.meta.dirname, '..', 'fixtures');

async function seeded(e: Engine, tracked = true): Promise<string> {
  const p = await e.createProject('framing');
  const dir = join(e.projectsDir, p.id);
  for (const d of ['media', 'shots', 'facetracks']) await mkdir(join(dir, d), { recursive: true });
  await copyFile(HEAD, join(dir, 'media', 'm_head.mp4'));
  await copyFile(join(FX, 'shots', 'talking-head-20s.json'), join(dir, 'shots', 'm_head.json'));
  await copyFile(join(FX, 'facetracks', 'talking-head-20s.json'), join(dir, 'facetracks', 'm_head.json'));
  const op = (o: unknown) => e.applyOp(p.id, o as never, { actor: 'cli' });
  await op({
    op: 'addMedia',
    args: {
      media: {
        id: 'm_head',
        kind: 'video',
        path: 'media/m_head.mp4',
        durationMs: 20000,
        width: 1920,
        height: 1080,
        hasAudio: true,
        fps: { num: 30, den: 1 },
        ...(tracked ? { shotsPath: 'shots/m_head.json', facetrackPath: 'facetracks/m_head.json' } : {}),
        origin: { type: 'upload' },
        tags: [],
      },
    },
  });
  await op({ op: 'addSequence', args: { name: 'Main', id: 'seq_a', styleId: 'base' } });
  const place = (startMs: number, inMs: number, frame: Frame) =>
    op({
      op: 'placeClip',
      args: { sequenceId: 'seq_a', trackId: 'V1', mediaId: 'm_head', startMs, inMs, durationMs: 3000, frame },
    });
  await place(0, 2000, { mode: 'facetrack', stability: 'follow' });
  await place(3000, 9000, { mode: 'auto' });
  return p.id;
}

const html = (b: { files: Map<string, string | Uint8Array> }) => String(b.files.get('index.html'));

describe('facetrack path provider (9b)', () => {
  test('facetrack and auto clips compile to the builder keyframes; stability recompiles', async () => {
    const e = openEngine({ projectsDir: join(tempDir('vox-framing-'), 'Projects'), stylesDirs: [REPO_STYLES] });
    const id = await seeded(e);
    const p = await e.getProject(id);
    const seq = p.sequences[0]!;
    const aspect = { width: seq.canvas.width, height: seq.canvas.height };
    // Expected: the builder's path for each clip, cut to its window, through an explicit provider.
    const expected = new Map<string, unknown>();
    for (const it of seq.videoTracks[0]!.items) {
      if (it.type !== 'media') continue;
      const path = await e.facetrackPath(id, 'm_head', trackOptionsFromFrame(it.frame!, aspect));
      expected.set(it.id, applyClipFraming(path, { inMs: it.inMs, durationMs: it.durationMs }));
    }
    const explicit: FramingProvider = (_m, c) => expected.get(c.id) as never;
    const ref = openEngine({
      projectsDir: e.projectsDir,
      stylesDirs: [REPO_STYLES],
      framing: explicit,
    });
    const want = html(await ref.compile(id, 'seq_a', { mode: 'render' }));
    const got = html(await e.compile(id, 'seq_a', { mode: 'render' }));
    expect(got).toBe(want);
    // The tracked path moves: more than one transform step per clip.
    for (const it of seq.videoTracks[0]!.items) {
      const steps = got.split(`tl.to(byId('${it.id}')`).length - 1;
      expect(steps, it.id).toBeGreaterThan(0);
    }
    const first = seq.videoTracks[0]!.items[0]!;
    await e.applyOp(
      id,
      {
        op: 'updateClip',
        args: { sequenceId: 'seq_a', itemId: first.id, frame: { mode: 'facetrack', stability: 'locked' } },
      } as never,
      { actor: 'cli' },
    );
    const changed = html(await e.compile(id, 'seq_a', { mode: 'render' }));
    expect(changed).not.toBe(got);
  });

  test('a clip whose media has no facetrack keeps its static crop', async () => {
    const e = openEngine({ projectsDir: join(tempDir('vox-framing-'), 'Projects'), stylesDirs: [REPO_STYLES] });
    const id = await seeded(e, false);
    const got = html(await e.compile(id, 'seq_a', { mode: 'render' }));
    expect(got).not.toContain("tl.to(byId('");
  });
});
