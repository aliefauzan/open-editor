import { describe, expect, test } from 'vitest';
import { decodeBits, decodeStream } from '../lib/barcode.ts';
import { FPS30, NTSC, frameToSec, fpsString, secToFrame } from '../lib/frames.ts';
import {
  cutFrames,
  expectedAt,
  makeMainSequence,
  makeNtscSequence,
  type SceneItem,
  type VideoItem,
} from '../lib/model.ts';

describe('frames', () => {
  test('frame <-> seconds round-trips at 30 and 30000/1001', () => {
    for (const fps of [FPS30, NTSC]) {
      for (let f = 0; f < 3000; f += 7) expect(secToFrame(frameToSec(f, fps), fps)).toBe(f);
    }
    expect(frameToSec(30, FPS30)).toBe(1);
    expect(frameToSec(30000, NTSC)).toBeCloseTo(1001, 9);
    expect(fpsString(FPS30)).toBe('30');
    expect(fpsString(NTSC)).toBe('30000/1001');
  });
});

describe('barcode', () => {
  test('decodes MSB-first 16 cells with a threshold', () => {
    const cells = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 255];
    expect(decodeBits(cells)).toBe(5);
    expect(decodeBits(cells.map((c) => (c ? 200 : 40)))).toBe(5);
  });
  test('splits a raw stream into one value per frame', () => {
    const one = Buffer.from([...Array(15).fill(0), 255]);
    const two = Buffer.from([...Array(14).fill(0), 255, 0]);
    expect(decodeStream(Buffer.concat([one, two]))).toEqual([1, 2]);
  });
});

describe('main sequence (90 s spike fixture)', () => {
  const seq = makeMainSequence();
  const videos = seq.items.filter((i): i is VideoItem => i.kind === 'video');
  const scenes = seq.items.filter((i): i is SceneItem => i.kind === 'scene');

  test('is 90 s at 1080x1920, 30 fps', () => {
    expect(seq.durF).toBe(2700);
    expect([seq.width, seq.height]).toEqual([1080, 1920]);
    expect(seq.fps).toEqual(FPS30);
  });

  test('has >= 40 V1 cuts of the spike source and VFR phone cuts', () => {
    expect(videos.filter((v) => v.src === 'spike').length).toBeGreaterThanOrEqual(40);
    expect(videos.filter((v) => v.src === 'phone').length).toBeGreaterThanOrEqual(4);
  });

  test('has 8 scenes incl. a stack with 2 panels and a video slot', () => {
    expect(scenes).toHaveLength(8);
    const stack = scenes.find((s) => s.template === 'stack');
    expect(stack?.panels).toHaveLength(2);
    expect(scenes.some((s) => s.template === 'video-slot')).toBe(true);
    expect(new Set(scenes.map((s) => s.style))).toEqual(new Set(['base', 'vox']));
  });

  test('V1 covers every frame exactly once outside the crossfade', () => {
    const v1 = seq.items.filter((i) => i.track === 'V1');
    const xf = videos.find((v) => v.fadeInF);
    expect(xf).toBeDefined();
    for (let f = 0; f < seq.durF; f++) {
      const on = v1.filter((i) => f >= i.startF && f < i.startF + i.durF).length;
      const inFade = xf && f >= xf.startF && f < xf.startF + (xf.fadeInF ?? 0);
      expect(on, `frame ${f}`).toBe(inFade ? 2 : 1);
    }
  });

  test('source ranges stay inside their sources', () => {
    for (const v of videos) {
      const len = v.src === 'spike' ? 2700 : 600;
      expect(v.inF).toBeGreaterThanOrEqual(0);
      expect(v.inF + v.durF).toBeLessThanOrEqual(len);
    }
  });

  test('every video clip has a linked audio clip with the same timing', () => {
    for (const v of videos) {
      const a = seq.items.find((i) => i.kind === 'audio' && i.linkedTo === v.id);
      expect(a).toMatchObject({ startF: v.startF, durF: v.durF, inF: v.inF, src: v.src });
    }
  });

  test('expectedAt reads the visible counter source and frame', () => {
    const first = videos[0]!;
    expect(expectedAt(seq, first.startF)).toEqual({
      src: first.src,
      frame: first.inF,
      itemId: first.id,
    });
    const stack = scenes.find((s) => s.template === 'stack')!;
    expect(expectedAt(seq, stack.startF)).toBeNull();
  });

  test('cut frames are the V1 boundaries between two video clips', () => {
    const cuts = cutFrames(seq);
    expect(cuts.length).toBeGreaterThanOrEqual(40);
    for (const c of cuts) {
      expect(expectedAt(seq, c - 1)).not.toBeNull();
      expect(expectedAt(seq, c)).not.toBeNull();
    }
  });

  test('is deterministic', () => {
    expect(JSON.stringify(makeMainSequence())).toBe(JSON.stringify(seq));
  });
});

describe('NTSC sequence', () => {
  const seq = makeNtscSequence();
  test('runs at 30000/1001 with cuts of the NTSC source', () => {
    expect(seq.fps).toEqual(NTSC);
    const videos = seq.items.filter((i): i is VideoItem => i.kind === 'video');
    expect(videos.length).toBeGreaterThanOrEqual(10);
    expect(videos.every((v) => v.src === 'ntsc' && v.inF + v.durF <= 599)).toBe(true);
  });
});
