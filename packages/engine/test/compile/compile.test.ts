// Compile (engine spec "Compile", phase 03 steps 7–10): snapshots, layer order, tracks, errors, S8
// hooks, stack panels, token scoping, entrance skip, caption presets, framing, VFR, S9.
import { describe, expect, test } from 'vitest';
import { hookSeed, readStyleAsset } from '../../src/compile/hooks.ts';
import { panelSize, presetText } from '../../src/compile/compile.ts';
import { captionsToSrt } from '../../src/model/captions.ts';
import type { Project } from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { baseProject, emptySequence, F30, track } from '../helpers/project.ts';
import {
  build,
  clip,
  image,
  instance,
  KIT,
  mainProject,
  media,
  registry,
  scene,
  serialise,
  varsOf,
} from './fixture.ts';

const index = (b: { files: Map<string, string | Uint8Array> }) =>
  b.files.get('index.html') as string;

function sceneProject(
  styleId: string,
  items: ReturnType<typeof scene>[],
  extra: Partial<Project['sequences'][number]> = {},
): Project {
  return baseProject(
    {
      ...emptySequence('seq_s', F30),
      styleId,
      videoTracks: [track('V1', items), track('V2')],
      audioTracks: [track('A1'), track('A2')],
      ...extra,
    },
    [media('m_a'), image('m_img')],
  );
}

describe('snapshots (step 7)', () => {
  test.each(['render', 'preview'] as const)(
    '%s build matches the snapshot and reruns byte-identical',
    async (mode) => {
      const a = serialise(await build(mainProject(), { mode }));
      const b = serialise(await build(mainProject(), { mode }));
      expect(b).toBe(a);
      await expect(a).toMatchFileSnapshot(`__snapshots__/main.${mode}.txt`);
    },
  );
});

describe('layers and tracks (step 9)', () => {
  test('paint order is V1, its transitions, V2, captions; no audio in render', async () => {
    const html = index(await build(mainProject()));
    const order = ['track-V1"', 'track-V1-tx"', 'track-V2"', 'track-captions"'].map((k) =>
      html.indexOf(`id="${k}`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('<audio');
  });

  test('hidden video tracks are skipped; muted audio tracks are skipped in preview', async () => {
    const p = mainProject();
    p.sequences[0]!.videoTracks[1]!.hidden = true;
    p.sequences[0]!.audioTracks[1]!.muted = true;
    const html = index(await build(p, { mode: 'preview' }));
    expect(html).not.toContain('track-V2');
    expect(html).not.toContain('it_t1');
    expect(html).toContain('<audio id="it_a1"');
    expect(html).not.toContain('it_m1');
  });

  test('preview: audio clips with clamped volume and fades; video media start has the +1 ms bias', async () => {
    const p = mainProject();
    const music = p.sequences[0]!.audioTracks[1]!.items[0]!;
    if (music.type === 'media') music.volume = 1.5;
    const html = index(await build(p, { mode: 'preview' }));
    expect(html).toMatch(/<audio id="it_m1" src="audio\/m_music\.m4a"[^>]*data-volume="1"/);
    expect(html).toContain(
      `tl.fromTo(byId('it_m1'), { volume: 1 }, { volume: 0, duration: 1, ease: 'none' }, 5);`,
    );
    // it_v1 starts 1000 ms into m_a: 1 s + 1 ms in preview, exact in render
    expect(html).toMatch(/<video id="it_v1" src="media\/m_a\.mp4"[^>]*data-media-start="1\.001"/);
    const render = index(await build(p));
    expect(render).toMatch(/<video id="it_v1"[^>]*data-media-start="1"/);
  });

  test('a media id missing from the library fails with MEDIA_MISSING', async () => {
    const p = mainProject();
    p.media = p.media.filter((m) => m.id !== 'm_b');
    await expect(build(p)).rejects.toMatchObject({
      code: 'MEDIA_MISSING',
      details: { mediaId: 'm_b', itemId: 'it_v2' },
    });
  });

  test('a major template version mismatch fails with TEMPLATE_VERSION', async () => {
    const p = sceneProject('kit', [scene('it_c', 'kit/card', '1.4.0', 0, 2000, { title: 'x' })]);
    await expect(build(p, { mode: 'render' }, registry(['kit']))).rejects.toMatchObject({
      code: 'TEMPLATE_VERSION',
      details: { placed: '1.4.0', installed: '2.1.0' },
    });
    const ok = sceneProject('kit', [scene('it_c', 'kit/card', '2.0.0', 0, 2000, { title: 'x' })]);
    await expect(build(ok, { mode: 'render' }, registry(['kit']))).resolves.toBeTruthy();
  });

  test('VFR video compiles to its CFR copy in render, the proxy in preview', async () => {
    const r = await build(mainProject());
    expect(r.links.get('media/m_b.mp4')).toMatch(/cfr\/m_b\.mp4$/);
    const pv = await build(mainProject(), { mode: 'preview' });
    expect(pv.links.get('media/m_b.mp4')).toMatch(/proxies\/m_b\.mp4$/);
    // no proxy: the player still never loads the VFR original (D-15)
    const noProxy = mainProject();
    delete noProxy.media.find((m) => m.id === 'm_b')!.proxyPath;
    const pv2 = await build(noProxy, { mode: 'preview' });
    expect(pv2.links.get('media/m_b.mp4')).toMatch(/cfr\/m_b\.mp4$/);
  });
});

describe('hooks (step 8, S8)', () => {
  const card = (startMs = 0) =>
    scene(`it_c${startMs}`, 'kit/card', '2.1.0', startMs, 2000, { title: 'route', photo: 'm_img' });

  test('a trusted hook gets ctx.readAsset, ctx.seed and a vendored import; output is deterministic', async () => {
    const p = sceneProject('kit', [card()]);
    const a = await build(p, { mode: 'render' }, registry(['kit']));
    const vars = varsOf(instance(a, 'it_c0'), 'it_c0');
    expect(vars).toMatchObject({
      title: 'ROUTE',
      seed: hookSeed('it_c0'),
      data: '../scenes/it_c0.files/route.txt',
      photo: '../media/m_img.jpg',
    });
    expect(a.files.get('scenes/it_c0.files/route.txt')).toBe(
      `lisbon,38.72,-9.14\nseed=${hookSeed('it_c0')}\n`,
    );
    const b = await build(p, { mode: 'render' }, registry(['kit']));
    expect(serialise(b)).toBe(serialise(a));
  });

  test('ctx.readAsset rejects .. and absolute paths', () => {
    const dir = `${KIT}/kit`;
    expect(readStyleAsset(dir, 'assets/data/places.csv').toString()).toContain('lisbon');
    for (const bad of [
      '../kitdraft/style.json',
      '/etc/hosts',
      'assets/../../kitdraft/style.json',
    ]) {
      expect(() => readStyleAsset(dir, bad)).toThrow(
        expect.objectContaining({ code: 'PATH_INVALID' }),
      );
    }
  });

  test("an untrusted style's own hook fails with HOOK_UNTRUSTED and never runs", async () => {
    const p = sceneProject('kitdraft', [
      scene('it_n', 'kitdraft/note', '1.0.0', 0, 2000, { label: 'n' }),
    ]);
    await expect(build(p, { mode: 'render' }, registry(['kit']))).rejects.toMatchObject({
      code: 'HOOK_UNTRUSTED',
      details: { template: 'kitdraft/note', styleId: 'kitdraft' },
    });
    // kit itself untrusted: its hook does not run either
    await expect(
      build(sceneProject('kit', [card()]), { mode: 'render' }, registry()),
    ).rejects.toMatchObject({
      code: 'HOOK_UNTRUSTED',
    });
  });

  test("a trusted parent's template used through an untrusted child style still runs its hook", async () => {
    const p = sceneProject('kitdraft', [card()]);
    const b = await build(p, { mode: 'render' }, registry(['kit']));
    expect(varsOf(instance(b, 'it_c0'), 'it_c0')).toMatchObject({ title: 'ROUTE' });
  });
});

describe('stack panels and token scoping (step 9)', () => {
  test('stack panels are resolved into nested instances (depth 1)', async () => {
    const p = sceneProject('kit', [
      scene('it_s', 'kit/stack', '1.0.0', 0, 3000, {
        panels: [
          { template: 'kit/swatch', variables: { label: 'one' } },
          { template: 'base/title', variables: { title: 'two' } },
        ],
      }),
    ]);
    const b = await build(p, { mode: 'render' }, registry(['kit']));
    const host = instance(b, 'it_s');
    expect(host).toContain(
      '<div id="it_s-p0" class="vox-panel" data-vox-panel="0" data-composition-id="it_s-p0" data-composition-src="scenes/it_s-p0.html" data-start="0" data-duration="3"',
    );
    expect(host).toContain('data-composition-src="scenes/it_s-p1.html"');
    // kit/stack sets panelAspect 16:9 (D-71): panels are 1080x608 in the 1080x1920 sequence
    expect(host).toContain('data-width="1080" data-height="608"');
    expect(instance(b, 'it_s-p0')).toContain('data-height="608"');
    expect(instance(b, 'it_s')).toContain('data-height="1920"');
    expect(varsOf(instance(b, 'it_s-p0'), 'it_s-p0')).toEqual({ label: 'one' });
    expect(varsOf(instance(b, 'it_s-p1'), 'it_s-p1')).toEqual({ title: 'two' });
    const pv = await build(p, { mode: 'preview' }, registry(['kit']));
    expect(index(pv)).toContain('<template id="it_s-p1-template">');
  });

  test('panelAspect gives panels the canvas width and the height of the ratio (D-71)', () => {
    expect(panelSize({ width: 1080, height: 1920 }, undefined)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(panelSize({ width: 1080, height: 1920 }, '16:9')).toEqual({ width: 1080, height: 608 });
    expect(panelSize({ width: 1920, height: 1080 }, '16:9')).toEqual({ width: 1920, height: 1080 });
    expect(panelSize({ width: 720, height: 1280 }, '4:3')).toEqual({ width: 720, height: 540 });
  });

  test('an inherited template takes the sequence style tokens; an unrelated style keeps its own', async () => {
    const title = scene('it_t', 'base/title', '1.0.0', 0, 2000, { title: 'x' });
    const swatch = scene('it_w', 'kit/swatch', '1.0.0', 2000, 2000, { label: 'w' });
    const inKit = await build(
      sceneProject('kitdraft', [title, swatch]),
      { mode: 'render' },
      registry(),
    );
    // base/title in a kitdraft sequence: kitdraft's accent
    expect(instance(inKit, 'it_t')).toContain('--tok-color-accent: #00aa00;');
    const inBase = await build(
      sceneProject('base', [title, swatch]),
      { mode: 'render' },
      registry(),
    );
    expect(instance(inBase, 'it_t')).toContain('--tok-color-accent: #2f6fed;');
    // kit/swatch in a base sequence: kit's own tokens
    expect(instance(inBase, 'it_w')).toContain('--tok-color-accent: #ff5500;');
    expect(instance(inBase, 'it_w')).toContain('--tok-color-kit: #123456;');
  });
});

describe('token scoping with the real vox style (phase 07 step 9)', () => {
  test('base/text-overlay in a vox sequence carries vox tokens; a vox template in a base sequence keeps them', async () => {
    const overlay = scene('it_o', 'base/text-overlay', '1.0.0', 0, 2000, { text: 'Rotterdam' });
    const kinetic = scene('it_k', 'vox/kinetic-serif', '1.0.0', 2000, 2000, { text: 'a b c' });
    const inVox = await build(sceneProject('vox', [overlay, kinetic]), { mode: 'render' });
    expect(instance(inVox, 'it_o')).toContain('--tok-color-accent: #D7261E;');
    expect(instance(inVox, 'it_o')).toContain('--tok-font-display: "DM Serif Display";');
    const inBase = await build(sceneProject('base', [overlay, kinetic]), { mode: 'render' });
    expect(instance(inBase, 'it_o')).toContain('--tok-color-accent: #2f6fed;');
    expect(instance(inBase, 'it_k')).toContain('--tok-color-accent: #D7261E;');
    expect(instance(inBase, 'it_k')).toContain('--tok-motion-frame-hold: 2;');
  });
});

describe('a sequence mixing vox and base templates (phase 07 step 10)', () => {
  test.each(['render', 'preview'] as const)(
    'compiles in %s mode with the vox overlay',
    async (mode) => {
      const p = sceneProject('vox', [
        scene('it_1', 'base/title', '1.0.0', 0, 2000, { title: 'Ports' }),
        {
          ...scene('it_2', 'vox/stat', '1.0.0', 2000, 2500, { value: '78%', line2: 'by sea' }),
          transitionIn: { template: 'vox/paper-tear', durationMs: 600 },
        },
        scene('it_3', 'vox/map-route', '1.0.0', 4500, 3000, {
          places: [
            { name: 'Rotterdam', lat: 51.92, lon: 4.48 },
            { name: 'Mumbai', lat: 19.08, lon: 72.88 },
          ],
          route: true,
        }),
        {
          ...scene('it_4', 'vox/paper-collage', '1.0.0', 7500, 2500, {
            items: [{ media: 'm_img', x: 50, y: 40 }],
          }),
          transitionIn: { template: 'base/dip-to-black', durationMs: 400 },
        },
      ]);
      const b = await build(p, { mode });
      const html = index(b);
      expect(html).toContain('id="overlay-paper-grain"');
      for (const id of ['it_1', 'it_2', 'it_3', 'it_4']) expect(html).toContain(`id="${id}"`);
      // the map hook ran (trusted built-in style) and wrote its file
      expect([...b.files.keys()].some((f) => f.endsWith('/map.svg'))).toBe(true);
    },
  );
});

describe('D-15 compile details (step 9b)', () => {
  test('skipEntrance is injected when a scene is shorter than minEntranceMs', async () => {
    const p = sceneProject('base', [
      scene('it_short', 'base/title', '1.0.0', 0, 1000, { title: 'a' }),
      scene('it_long', 'base/title', '1.0.0', 1000, 2000, { title: 'b' }),
    ]);
    const b = await build(p);
    expect(varsOf(instance(b, 'it_short'), 'it_short')).toEqual({ title: 'a', skipEntrance: true });
    expect(varsOf(instance(b, 'it_long'), 'it_long')).toEqual({ title: 'b' });
  });

  test("a preset's case/stripPunctuation apply in the build, not in the SRT", async () => {
    const p = mainProject('kit');
    p.sequences[0]!.captions = { ...CAPTION_DEFAULTS, preset: 'kit/loud', overrides: [] };
    const b = await build(p, { mode: 'render' }, registry(['kit']));
    const vars = varsOf(instance(b, 'captions'), 'captions') as {
      chunks: { lines: { words: { text: string }[] }[] }[];
    };
    const words = vars.chunks.flatMap((c) => c.lines.flatMap((l) => l.words.map((w) => w.text)));
    // it_a1 starts 1 s into m_a, so "Hello there," is outside the clip
    expect(words.slice(0, 5)).toEqual(['THIS', 'IS', 'VOX', 'IT', 'HAS']);
    expect(b.files.get('captions.srt')).toBe(captionsToSrt(b.captions));
    expect(b.files.get('captions.srt')).toContain('this is Vox.');
    expect(
      presetText(b.captions, { case: 'lower', stripPunctuation: false })[0]!.lines[0]!.words[2]!
        .text,
    ).toBe('vox.');
  });

  test('a tiered preset puts key words on their own line in the build and the SRT (D-93)', async () => {
    const p = mainProject('kit');
    p.sequences[0]!.captions = {
      ...CAPTION_DEFAULTS,
      preset: 'kit/loud',
      maxWords: 5,
      maxLines: 2,
      autoEmphasis: true,
      overrides: [],
    };
    const reg = registry(['kit']);
    const lines = async () => {
      const b = await build(p, { mode: 'render' }, reg);
      const vars = varsOf(instance(b, 'captions'), 'captions') as {
        chunks: { lines: { words: { text: string; emphasis: boolean }[] }[] }[];
      };
      return vars.chunks.map((c) => c.lines.map((l) => l.words.map((w) => w.text).join(' ')));
    };
    const untiered = await lines();
    expect(untiered).toEqual([['THIS IS VOX'], ['IT HAS 42 CLIPS']]);
    // the resolved preset is the registry's own object: mark it tiered for this build
    reg.get('kit').captionPresets['kit/loud']!.tiered = true;
    const tiered = await lines();
    expect(tiered).toEqual([
      ['THIS IS', 'VOX'],
      ['IT HAS', '42 CLIPS'],
    ]);
    const b = await build(p, { mode: 'render' }, reg);
    expect(b.files.get('captions.srt')).toContain('It has\n42 clips!');
  });

  test('facetrack, auto and manual keyframes become a transform; cover/contain use object-fit', async () => {
    const kfs = [
      { atMs: 0, x: 0.5, y: 0.5, scale: 1 },
      { atMs: 1000, x: 0.25, y: 0.5, scale: 2 },
    ];
    const p = sceneProject('base', []);
    const s = p.sequences[0]!;
    s.videoTracks[0]!.items = [
      clip('it_f', 'm_a', 0, 2000, 0, { frame: { mode: 'facetrack' } }),
      clip('it_m', 'm_a', 2000, 2000, 0, { frame: { mode: 'manual', keyframes: kfs } }),
      clip('it_s', 'm_a', 4000, 2000, 0, { frame: { mode: 'manual', x: 0.2, y: 0.5, scale: 1 } }),
      clip('it_c', 'm_a', 6000, 1000, 0, { frame: { mode: 'contain' } }),
    ];
    const html = index(
      await build(p, { mode: 'render' }, registry(), {
        framing: (m, c) => (c.id === 'it_f' && m.id === 'm_a' ? kfs : undefined),
      }),
    );
    // 1920x1080 source on 1080x1920: the cover crop is 0.3164 x 1 of the source, so the element is
    // 3413.333 x 1920 and centring x = 0.5 needs translate(-1166.667, 0)
    expect(html).toMatch(
      /<video id="it_f"[^>]*style="position: absolute; left: 0; top: 0; width: 3413\.333px; height: 1920px; object-fit: fill; transform-origin: 0 0; transform: translate\(-1166\.667px, 0px\) scale\(1\);"/,
    );
    expect(html).toContain(
      // [position, x, y, scale, duration]: set at 0, then a 1 s tween from 0
      `voxPath('it_f', [[0, -1166.667, 0, 1, 0], [0, -1166.667, -960, 2, 1]]);`,
    );
    expect(html).toContain(
      `voxPath('it_m', [[2, -1166.667, 0, 1, 0], [2, -1166.667, -960, 2, 1]]);`,
    );
    // static manual crop: x = 0.2 → 540 - 0.2 × 3413.333
    expect(html).toMatch(
      /<video id="it_s"[^>]*transform: translate\(-142\.667px, 0px\) scale\(1\);"/,
    );
    expect(html).toMatch(/<video id="it_c"[^>]*object-fit: contain;"/);
  });

  test('a long tracked path is one script line per clip (hyperframes lint: ≤ 300 lines per file)', async () => {
    // a 60 s quick clip has hundreds of path keyframes; one tween line each broke `--strict-all`
    const kfs = Array.from({ length: 600 }, (_, i) => ({
      atMs: i * 3,
      x: 0.4 + (i % 2) * 0.1,
      y: 0.5,
      scale: 1.2,
    }));
    const p = sceneProject('base', []);
    p.sequences[0]!.videoTracks[0]!.items = [
      clip('it_f', 'm_a', 0, 2000, 0, { frame: { mode: 'facetrack' } }),
    ];
    const html = index(await build(p, { mode: 'render' }, registry(), { framing: () => kfs }));
    const structural = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
    expect(structural.split('\n').length).toBeLessThanOrEqual(300);
    expect(html.match(/^\s*voxPath\('it_f', /gm)).toHaveLength(1);
  });
});

describe('S9 (step 10)', () => {
  test('no http(s) URL in any generated file of a build', async () => {
    for (const mode of ['render', 'preview'] as const) {
      const b = await build(mainProject(), { mode });
      for (const [path, content] of b.files) {
        if (typeof content === 'string') expect(content, path).not.toMatch(/https?:\/\//);
      }
    }
  });
});

describe('range', () => {
  test('a range shifts media and drops scenes cut by its start, with a warning', async () => {
    const b = await build(mainProject(), { mode: 'render', range: { startMs: 1000, endMs: 4000 } });
    expect(b.durationMs).toBe(3000);
    const html = index(b);
    expect(html).toMatch(
      /<video id="it_v1"[^>]*data-start="0" data-duration="2" data-media-start="2"/,
    );
    expect(html).not.toContain('id="it_t1"');
    expect(b.warnings).toContain('it_t1: scene starts before the range; dropped');
  });
});
