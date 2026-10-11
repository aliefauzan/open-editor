import { describe, expect, test } from 'vitest';
import { compile, type MediaSet } from '../lib/compile.ts';
import { makeMainSequence } from '../lib/model.ts';
import { colorDist, hexRgb, meanRgb, mechanismProbes } from '../lib/probes.ts';

const fps = { num: 30, den: 1 };
const media: MediaSet = {
  spike: { render: '/m/spike.mp4', preview: '/m/spike.proxy.mp4', audio: '/m/spike.m4a', fps },
  phone: { render: '/m/phone.cfr.mp4', preview: '/m/phone.proxy.mp4', audio: '/m/phone.m4a', fps },
  ntsc: {
    render: '/m/ntsc.mp4',
    preview: '/m/ntsc.proxy.mp4',
    audio: '/m/ntsc.m4a',
    fps: { num: 30000, den: 1001 },
  },
  face: '/m/face-a.jpg',
  transcript: { words: [{ text: 'hello', startMs: 500, endMs: 900, kind: 'word' }] },
};

describe('pixel probes', () => {
  test('hexRgb and colorDist', () => {
    expect(hexRgb('#ff00ff')).toEqual([255, 0, 255]);
    expect(colorDist([255, 0, 255], [255, 0, 255])).toBe(0);
    expect(colorDist([0, 0, 0], [3, 4, 0])).toBe(5);
  });

  test('meanRgb reads RGB and BGRA boxes', () => {
    const w = 4;
    const rgb = new Uint8Array(w * 4 * 3);
    const bgra = new Uint8Array(w * 4 * 4);
    for (let i = 0; i < w * 4; i++) {
      rgb.set([10, 20, 30], i * 3);
      bgra.set([30, 20, 10, 255], i * 4);
    }
    expect(meanRgb(rgb, w, [1, 1, 2, 2])).toEqual([10, 20, 30]);
    expect(meanRgb(bgra, w, [0, 0, 4, 4], 4, 'bgr')).toEqual([10, 20, 30]);
  });

  test('mechanism probes cover every mounted instance with boxes on the canvas', () => {
    const probes = mechanismProbes(makeMainSequence());
    const swatches = probes.flatMap((p) => p.points.filter((x) => x.what === 'swatch'));
    expect(swatches.length).toBe(10);
    for (const pt of probes.flatMap((p) => p.points)) {
      const [x, y, bw, bh] = pt.box;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + bw).toBeLessThanOrEqual(1080);
      expect(y + bh).toBeLessThanOrEqual(1920);
    }
  });
});

describe('preview video bias', () => {
  test('preview video in-points carry +1 ms, render and audio stay exact', () => {
    const seq = makeMainSequence();
    const v = seq.items.find((i) => i.kind === 'video' && i.id === 'c1')!;
    const exact = (v as { inF: number }).inF / 30;
    const attr = (html: string, tag: string, id: string) =>
      Number(new RegExp(`<${tag} id="${id}"[^>]*data-media-start="([^"]+)"`).exec(html)![1]);
    const preview = compile(seq, 'preview', media).files.get('index.html')!;
    const render = compile(seq, 'render', media).files.get('index.html')!;
    expect(attr(preview, 'video', 'c1')).toBeCloseTo(exact + 0.001, 9);
    expect(attr(render, 'video', 'c1')).toBe(exact);
    expect(attr(preview, 'audio', 'a1')).toBe(exact);
  });
});
