// Facetrack path provider (phase 05 step 9b, moved from 04): the engine's compile plugs 04's path
// builder into 03's framing interface. A `facetrack` and an `auto` clip on the seeded talking-head
// media compile to the same transform keyframes as the builder's own output (applied to the clip
// window), a clip without a facetrack keeps its static crop, and a changed `stability` recompiles
// to a different path. The cuts-2shot run with real detection is `framing-provider.local.test.ts`.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, type Engine, type FramingProvider } from '../../src/api.ts';
import type { Frame } from '../../src/model/schema.ts';
import { applyClipFraming, cropSize, trackOptionsFromFrame } from '../../src/stages/facetrack.ts';
import { tempDir } from '../helpers/store.ts';
import { HEAD, REPO_STYLES } from '../export/project.ts';

const FX = join(import.meta.dirname, '..', 'fixtures');

async function seeded(
  e: Engine,
  tracked = true,
  canvas?: { width: number; height: number },
): Promise<string> {
  const p = await e.createProject('framing');
  const dir = join(e.projectsDir, p.id);
  for (const d of ['media', 'shots', 'facetracks']) await mkdir(join(dir, d), { recursive: true });
  await copyFile(HEAD, join(dir, 'media', 'm_head.mp4'));
  await copyFile(join(FX, 'shots', 'talking-head-20s.json'), join(dir, 'shots', 'm_head.json'));
  await copyFile(
    join(FX, 'facetracks', 'talking-head-20s.json'),
    join(dir, 'facetracks', 'm_head.json'),
  );
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
        ...(tracked
          ? { shotsPath: 'shots/m_head.json', facetrackPath: 'facetracks/m_head.json' }
          : {}),
        origin: { type: 'upload' },
        tags: [],
      },
    },
  });
  await op({
    op: 'addSequence',
    args: { name: 'Main', id: 'seq_a', styleId: 'base', ...(canvas ? { canvas } : {}) },
  });
  const place = (startMs: number, inMs: number, frame: Frame) =>
    op({
      op: 'placeClip',
      args: {
        sequenceId: 'seq_a',
        trackId: 'V1',
        mediaId: 'm_head',
        startMs,
        inMs,
        durationMs: 3000,
        frame,
      },
    });
  await place(0, 2000, { mode: 'facetrack', stability: 'follow' });
  await place(3000, 9000, { mode: 'auto' });
  return p.id;
}

const html = (b: { files: Map<string, string | Uint8Array> }) => String(b.files.get('index.html'));

describe('facetrack path provider (9b)', () => {
  test('facetrack and auto clips compile to the builder keyframes; stability recompiles', async () => {
    const e = openEngine({
      projectsDir: join(tempDir('vox-framing-'), 'Projects'),
      stylesDirs: [REPO_STYLES],
    });
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
      const path = new RegExp(`voxPath\\('${it.id}', \\[(.*)\\]\\);`).exec(got);
      const tweens = (path?.[1] ?? '').split('], [').filter((s) => !/, 0\]?$/.test(s)).length;
      expect(tweens, it.id).toBeGreaterThan(0);
    }
    const first = seq.videoTracks[0]!.items[0]!;
    await e.applyOp(
      id,
      {
        op: 'updateClip',
        args: {
          sequenceId: 'seq_a',
          itemId: first.id,
          frame: { mode: 'facetrack', stability: 'locked' },
        },
      } as never,
      { actor: 'cli' },
    );
    const changed = html(await e.compile(id, 'seq_a', { mode: 'render' }));
    expect(changed).not.toBe(got);
  });

  test('a clip whose media has no facetrack keeps its static crop', async () => {
    const e = openEngine({
      projectsDir: join(tempDir('vox-framing-'), 'Projects'),
      stylesDirs: [REPO_STYLES],
    });
    const id = await seeded(e, false);
    const got = html(await e.compile(id, 'seq_a', { mode: 'render' }));
    expect(got).not.toContain("voxPath('");
  });
});

// Letterboxed sources: ingest stores the active picture area in `cache/media/<id>.json`; the
// tracked and the static crop of a `facetrack`/`auto` clip stay inside it, in render and preview.
describe('active area (black bars baked into the source)', () => {
  const VERTICAL = { width: 1080, height: 1920 };
  /** 1920×1080 with a 1920×800 picture between 140 px bars. */
  const AREA = { x: 0, y: 140, w: 1920, h: 800 };

  async function letterboxed(tracked: boolean, area: object | null = AREA) {
    const e = openEngine({
      projectsDir: join(tempDir('vox-framing-'), 'Projects'),
      stylesDirs: [REPO_STYLES],
    });
    const id = await seeded(e, tracked, VERTICAL);
    if (area) {
      const cache = join(e.projectsDir, id, 'cache', 'media');
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, 'm_head.json'), JSON.stringify({ activeArea: area }));
    }
    return { e, id };
  }

  /** Every crop (static style and each voxPath step) as a rectangle in source pixels. */
  function crops(h: string): { left: number; right: number; top: number; bottom: number }[] {
    const W = VERTICAL.width;
    const H = VERTICAL.height;
    const cover = cropSize({ width: 1920, height: 1080 }, VERTICAL);
    const vw = W / cover.w;
    const vh = H / cover.h;
    const rect = (tx: number, ty: number, s: number) => {
      const x = (W / 2 - tx) / (vw * s);
      const y = (H / 2 - ty) / (vh * s);
      const c = cropSize({ width: 1920, height: 1080 }, VERTICAL, s);
      return {
        left: (x - c.w / 2) * 1920,
        right: (x + c.w / 2) * 1920,
        top: (y - c.h / 2) * 1080,
        bottom: (y + c.h / 2) * 1080,
      };
    };
    const out = [];
    for (const m of h.matchAll(
      /<video [^>]*transform: translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/g,
    )) {
      out.push(rect(Number(m[1]), Number(m[2]), Number(m[3])));
    }
    for (const m of h.matchAll(/voxPath\('[^']+', \[(.*)\]\);/g)) {
      for (const step of m[1]!.slice(1, -1).split('], [')) {
        const [, x, y, s] = step.split(', ').map(Number);
        out.push(rect(x!, y!, s!));
      }
    }
    return out;
  }
  function expectInsideArea(h: string): void {
    const all = crops(h);
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      // within half a source pixel (the transforms are rounded to 1/1000 px on the canvas)
      expect(r.left).toBeGreaterThanOrEqual(AREA.x - 0.5);
      expect(r.right).toBeLessThanOrEqual(AREA.x + AREA.w + 0.5);
      expect(r.top).toBeGreaterThanOrEqual(AREA.y - 0.5);
      expect(r.bottom).toBeLessThanOrEqual(AREA.y + AREA.h + 0.5);
    }
  }

  test('tracked 9:16 crops stay inside the area; preview agrees with render', async () => {
    const { e, id } = await letterboxed(true);
    const got = html(await e.compile(id, 'seq_a', { mode: 'render' }));
    expectInsideArea(got);
    const preview = html(await e.compile(id, 'seq_a', { mode: 'preview' }));
    expect(crops(preview)).toEqual(crops(got));
    // the bars are cut away: every crop is at most the area height
    for (const r of crops(got)) expect(r.bottom - r.top).toBeLessThanOrEqual(800.5);
  });

  test('a clip without a facetrack gets a static crop inside the area', async () => {
    const { e, id } = await letterboxed(false);
    const got = html(await e.compile(id, 'seq_a', { mode: 'render' }));
    expectInsideArea(got);
    const preview = html(await e.compile(id, 'seq_a', { mode: 'preview' }));
    expect(crops(preview)).toEqual(crops(got));
  });

  test('a full-frame area or no cache file compiles exactly as before', async () => {
    for (const tracked of [true, false]) {
      const none = await letterboxed(tracked, null);
      const full = await letterboxed(tracked, { x: 0, y: 0, w: 1920, h: 1080 });
      const a = html(await none.e.compile(none.id, 'seq_a', { mode: 'render' }));
      const b = html(await full.e.compile(full.id, 'seq_a', { mode: 'render' }));
      expect(crops(b)).toEqual(crops(a));
      if (!tracked) expect(a).not.toContain("voxPath('");
    }
  });
});
