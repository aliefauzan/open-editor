import { describe, expect, test } from 'vitest';
import { compile, type MediaSet } from '../lib/compile.ts';
import { frameToSec } from '../lib/frames.ts';
import {
  makeMainSequence,
  makeNtscSequence,
  type SceneItem,
  type VideoItem,
} from '../lib/model.ts';

const media: MediaSet = {
  spike: {
    render: '/m/spike.mp4',
    preview: '/m/spike.proxy.mp4',
    audio: '/m/spike.m4a',
    fps: { num: 30, den: 1 },
  },
  phone: {
    render: '/m/phone.cfr.mp4',
    preview: '/m/phone.proxy.mp4',
    audio: '/m/phone.m4a',
    fps: { num: 30, den: 1 },
  },
  ntsc: {
    render: '/m/ntsc.mp4',
    preview: '/m/ntsc.proxy.mp4',
    audio: '/m/ntsc.m4a',
    fps: { num: 30000, den: 1001 },
  },
  face: '/m/face-a.jpg',
  transcript: { words: [{ text: 'hello', startMs: 500, endMs: 900, kind: 'word' }] },
};

const seq = makeMainSequence();
const videos = seq.items.filter((i): i is VideoItem => i.kind === 'video');
const scenes = seq.items.filter((i): i is SceneItem => i.kind === 'scene');

describe('render build', () => {
  const b = compile(seq, 'render', media);
  const index = b.files.get('index.html')!;

  test('root has canvas size and exact duration', () => {
    expect(index).toContain('data-composition-id="main"');
    expect(index).toContain('data-width="1080" data-height="1920" data-duration="90"');
  });

  test('every V1 video is a muted timed <video> with exact start and media-start', () => {
    for (const v of videos) {
      const tag = new RegExp(`<video id="${v.id}"[^>]*>`).exec(index)?.[0];
      expect(tag, v.id).toBeDefined();
      expect(tag).toContain(`data-start="${frameToSec(v.startF, seq.fps)}"`);
      expect(tag).toContain(`data-media-start="${frameToSec(v.inF, seq.fps)}"`);
      expect(tag).toContain(' muted');
      expect(tag).toContain(v.src === 'phone' ? 'media/phone.cfr.mp4' : 'media/spike.mp4');
    }
  });

  test('every linked audio is an <audio> with an id', () => {
    const n = (index.match(/<audio id="a\d+"/g) ?? []).length;
    expect(n).toBe(videos.length);
  });

  test('each scene is a per-instance file with its own vars and tokens', () => {
    for (const s of scenes) {
      const f = b.files.get(`scenes/${s.id}.html`);
      expect(f, s.id).toBeDefined();
      expect(f).toContain(`data-composition-id="${s.id}"`);
      expect(f).toContain(
        `<script type="application/json" data-vox-vars data-vox-instance="${s.id}">${JSON.stringify(s.vars)}`,
      );
      expect(f).toContain('--tok-accent');
      expect(index).toContain(`data-composition-src="scenes/${s.id}.html"`);
    }
    const stack = scenes.find((s) => s.template === 'stack')!;
    for (const p of stack.panels!) expect(b.files.get(`scenes/${p.id}.html`)).toBeDefined();
  });

  test('links originals and vendors gsap, no runtime (the CLI injects it)', () => {
    expect(b.links.get('media/spike.mp4')).toBe('/m/spike.mp4');
    expect(b.links.get('media/phone.cfr.mp4')).toBe('/m/phone.cfr.mp4');
    expect(b.vendor).toContain('gsap.min.js');
    expect(index).not.toContain('hyperframe.runtime.iife.js');
    expect(index).not.toMatch(/https?:\/\//);
  });

  test('is deterministic', () => {
    const again = compile(seq, 'render', media);
    expect([...again.files]).toEqual([...b.files]);
  });
});

describe('preview build', () => {
  const b = compile(seq, 'preview', media);
  const index = b.files.get('index.html')!;
  test('inlines scene templates, uses proxies and the vendored runtime', () => {
    expect(index).not.toContain('data-composition-src');
    for (const s of scenes) expect(index).toContain(`<template id="${s.id}-template">`);
    expect(index).toContain('media/spike.proxy.mp4');
    expect(index).toContain('src="vendor/hyperframe.runtime.iife.js"');
    expect([...b.files.keys()].filter((k) => k.startsWith('scenes/'))).toEqual([]);
  });
});

describe('NTSC build', () => {
  test('uses 30000/1001 times', () => {
    const s = makeNtscSequence();
    const b = compile(s, 'render', media);
    const v = s.items.find((i): i is VideoItem => i.kind === 'video' && i.startF > 0)!;
    expect(b.files.get('index.html')).toContain(`data-start="${(v.startF * 1001) / 30000}"`);
  });
});
