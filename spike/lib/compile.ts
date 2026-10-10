/**
 * Hand-rolled compile for the spike (engine spec "Compile"): sequence -> HyperFrames build, in memory.
 *
 * - render: `index.html` + per-instance `scenes/<id>.html` files (sub-compositions via
 *   `data-composition-src`), originals / CFR copy, GSAP + vox-runtime vendored, the CLI injects the
 *   HyperFrames runtime.
 * - preview: one `index.html` with every scene inlined as `<template id="<id>-template">` (the runtime
 *   mounts those without `fetch`, which the `vox-media://` CSP blocks), proxies, vendored runtime.
 *
 * Paint order is DOM order: V1, V2, captions; audio last.
 */
import { copyFileSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type Fps, frameToSec } from './frames.ts';
import {
  PANEL_BOXES,
  STYLE_TOKENS,
  type AudioItem,
  type ImageItem,
  type Item,
  type SceneItem,
  type Sequence,
  type StyleId,
  type VideoItem,
} from './model.ts';

export type Mode = 'render' | 'preview';

export interface SrcMedia {
  /** Original, or the CFR copy for a VFR source (D-15). */
  render: string;
  /** 540p proxy, keyframe every 0.5 s. */
  preview: string;
  /** The source's audio stream, copied (`-c:a copy`). */
  audio: string;
  /** Source frame rate (for `data-media-start`). */
  fps: Fps;
}

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  kind: string;
}

export interface MediaSet {
  spike: SrcMedia;
  phone: SrcMedia;
  ntsc: SrcMedia;
  face: string;
  transcript: { words: Word[] };
}

export interface Build {
  /** Build-relative path -> file content. */
  files: Map<string, string>;
  /** Build-relative path -> absolute source file to hard-link. */
  links: Map<string, string>;
  /** Vendored files (`vendor/<name>`), copied by `writeBuild`. */
  vendor: string[];
}

const TEMPLATES = path.join(import.meta.dirname, '..', 'templates');
const templateCache = new Map<string, string>();

function templateInner(name: string): string {
  let t = templateCache.get(name);
  if (t === undefined) {
    const html = readFileSync(path.join(TEMPLATES, `${name}.html`), 'utf8');
    const a = html.indexOf('<template>');
    const b = html.lastIndexOf('</template>');
    if (a < 0 || b < a) throw new Error(`template ${name}: no <template> block`);
    t = html.slice(a + '<template>'.length, b);
    templateCache.set(name, t);
  }
  return t;
}

const sec = (f: number, fps: Fps): string => String(frameToSec(f, fps));
const json = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

function tokens(style: StyleId): string {
  const t = STYLE_TOKENS[style];
  const props = Object.entries(t)
    .map(([k, v]) => `--tok-${k}: ${v};`)
    .join(' ');
  return `<style>\n        #root { ${props} }\n      </style>`;
}

interface Ctx {
  seq: Sequence;
  mode: Mode;
  media: MediaSet;
  build: Build;
  /** Preview: `<template id>` blocks collected at document level. */
  templates: string[];
}

function mediaPath(ctx: Ctx, abs: string, dir: 'media' | 'audio'): string {
  const rel = `${dir}/${path.basename(abs)}`;
  ctx.build.links.set(rel, abs);
  return rel;
}

function videoSrc(ctx: Ctx, src: VideoItem['src']): string {
  const m = ctx.media[src];
  return mediaPath(ctx, ctx.mode === 'render' ? m.render : m.preview, 'media');
}

/**
 * One scene instance (per-instance file in render, inline template in preview). Returns the host
 * element's attribute that points at it.
 */
function emitInstance(
  ctx: Ctx,
  id: string,
  template: string,
  style: StyleId,
  vars: unknown,
  durSec: string,
  extra: Record<string, string> = {},
): string {
  let inner = templateInner(template)
    .replaceAll('__ID__', id)
    .replaceAll('__DUR__', durSec)
    .replace('<!--vox:tokens-->', tokens(style))
    .replace(
      '<!--vox:vars-->',
      `<script type="application/json" data-vox-vars data-vox-instance="${id}">${json(vars)}</script>`,
    );
  for (const [k, v] of Object.entries(extra)) inner = inner.replaceAll(k, v);
  if (ctx.mode === 'render') {
    ctx.build.files.set(
      `scenes/${id}.html`,
      `<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n  <body>\n    <template>${inner}</template>\n  </body>\n</html>\n`,
    );
    return ` data-composition-src="scenes/${id}.html"`;
  }
  ctx.templates.push(`<template id="${id}-template">${inner}</template>`);
  return '';
}

/** Scene media paths: relative to the instance file in render (`scenes/`), to index in preview. */
const scenePath = (ctx: Ctx, rel: string): string => (ctx.mode === 'render' ? `../${rel}` : rel);

function sceneHost(ctx: Ctx, s: SceneItem): string {
  const fps = ctx.seq.fps;
  const dur = sec(s.durF, fps);
  const extra: Record<string, string> = {};
  if (s.template === 'video-slot') {
    const m = ctx.media.spike;
    extra.__SLOT_SRC__ = scenePath(ctx, videoSrc(ctx, 'spike'));
    extra.__SLOT_START__ = sec(s.slotInF ?? 0, m.fps);
  }
  if (s.template === 'stack') {
    const hosts = (s.panels ?? []).map((p, i) => {
      const src = emitInstance(ctx, p.id, 'panel', p.style, p.vars, dur);
      // nested sub-composition: the path is project-relative, like the top-level mounts (lint and
      // the render compiler resolve it from the project root)
      const rel = src;
      const box = PANEL_BOXES[i]!;
      return `<div id="${p.id}" class="k-panel" data-composition-id="${p.id}"${rel} data-start="0" data-duration="${dur}" data-width="960" data-height="760" style="top: ${box.y}px"></div>`;
    });
    extra['<!--vox:panels-->'] = hosts.join('\n        ');
  }
  const src = emitInstance(ctx, s.id, s.template, s.style, s.vars, dur, extra);
  return `<div id="${s.id}" class="clip host" data-composition-id="${s.id}"${src} data-start="${sec(s.startF, fps)}" data-duration="${dur}" data-track-index="${s.track === 'V1' ? 1 : 2}" data-width="1080" data-height="1920"></div>`;
}

function videoTag(ctx: Ctx, v: VideoItem): string {
  const fps = ctx.seq.fps;
  const cls = v.src === 'phone' ? 'full' : 'land';
  return `<video id="${v.id}" class="${cls}" src="${videoSrc(ctx, v.src)}" data-start="${sec(v.startF, fps)}" data-duration="${sec(v.durF, fps)}" data-media-start="${sec(v.inF, ctx.media[v.src].fps)}" data-track-index="1" muted playsinline></video>`;
}

function imageTag(ctx: Ctx, i: ImageItem): string {
  const fps = ctx.seq.fps;
  const src = mediaPath(ctx, ctx.media.face, 'media');
  // untimed crop wrapper; the timed <img> itself carries the push-in transform
  return `<div class="img-wrap"><img id="${i.id}" class="clip" src="${src}" alt="" data-start="${sec(i.startF, fps)}" data-duration="${sec(i.durF, fps)}" data-track-index="1" /></div>`;
}

function audioTag(ctx: Ctx, a: AudioItem, n: number): string {
  const fps = ctx.seq.fps;
  const src = mediaPath(ctx, ctx.media[a.src].audio, 'audio');
  return `<audio id="${a.id}" src="${src}" data-start="${sec(a.startF, fps)}" data-duration="${sec(a.durF, fps)}" data-media-start="${sec(a.inF, ctx.media[a.src].fps)}" data-volume="1" data-track-index="${10 + (n % 2)}"></audio>`;
}

/** Caption chunks (≤ 3 words, split at pauses), times relative to the captions composition. */
export function captionChunks(
  words: Word[],
  durSec: number,
): { text: string; start: number; end: number }[] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    if (w.kind !== 'word') {
      if (cur.length) groups.push(cur);
      cur = [];
      continue;
    }
    cur.push(w);
    if (cur.length === 3) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  const out = groups
    .map((g) => ({
      text: g.map((w) => w.text).join(' '),
      start: g[0]!.startMs / 1000,
      end: g[g.length - 1]!.endMs / 1000 + 0.4,
    }))
    .filter((c) => c.start < durSec);
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    out[i]!.end = Math.min(out[i]!.end, next ? next.start : durSec, durSec);
  }
  return out;
}

function mainScript(ctx: Ctx): string {
  const fps = ctx.seq.fps;
  const lines: string[] = [];
  for (const it of ctx.seq.items) {
    if (it.kind === 'video' && it.fadeInF)
      lines.push(
        `tl.fromTo(byId('${it.id}'), { opacity: 0 }, { opacity: 1, duration: ${sec(it.fadeInF, fps)}, ease: 'none' }, ${sec(it.startF, fps)});`,
      );
    if (it.kind === 'image')
      lines.push(
        `tl.fromTo(byId('${it.id}'), { scale: 1 }, { scale: 1.15, duration: ${sec(it.durF, fps)}, ease: 'none' }, ${sec(it.startF, fps)});`,
      );
    if (it.kind === 'audio' && it.fade)
      lines.push(
        `tl.fromTo(byId('${it.id}'), { volume: ${it.fade.from} }, { volume: ${it.fade.to}, duration: ${sec(it.fade.toF - it.fade.fromF, fps)}, ease: 'none' }, ${sec(it.fade.fromF, fps)});`,
      );
  }
  return `(function () {
        var byId = function (id) { return document.getElementById(id); };
        var tl = gsap.timeline({ paused: true });
        ${lines.join('\n        ')}
        window.__timelines['main'] = tl;
      })();`;
}

export function compile(seq: Sequence, mode: Mode, media: MediaSet): Build {
  const build: Build = {
    files: new Map(),
    links: new Map(),
    vendor: ['gsap.min.js', 'vox-runtime.js'],
  };
  if (mode === 'preview') build.vendor.push('hyperframe.runtime.iife.js');
  const ctx: Ctx = { seq, mode, media, build, templates: [] };
  const fps = seq.fps;
  const durSec = frameToSec(seq.durF, fps);
  const byStart = (a: Item, b: Item) => a.startF - b.startF;

  const layer = (track: 'V1' | 'V2') =>
    seq.items
      .filter((i) => i.track === track)
      .sort(byStart)
      .map((i) =>
        i.kind === 'video'
          ? videoTag(ctx, i)
          : i.kind === 'image'
            ? imageTag(ctx, i)
            : i.kind === 'scene'
              ? sceneHost(ctx, i)
              : '',
      );
  const v1 = layer('V1');
  const v2 = layer('V2');
  const audio = seq.items
    .filter((i): i is AudioItem => i.kind === 'audio')
    .sort(byStart)
    .map((a, n) => audioTag(ctx, a, n));

  let captions = '';
  if (seq.captions) {
    const d = String(durSec);
    const src = emitInstance(
      ctx,
      'captions',
      'captions',
      'base',
      { chunks: captionChunks(media.transcript.words, durSec) },
      d,
    );
    captions = `<div id="captions" class="clip host" data-composition-id="captions"${src} data-track-kind="captions" data-start="0" data-duration="${d}" data-track-index="3" data-width="1080" data-height="1920"></div>`;
  }

  const head = build.vendor.map((v) => `    <script src="vendor/${v}"></script>`).join('\n');
  const fpsAttr = fps.den === 1 ? ` data-fps="${fps.num}"` : '';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${seq.width}, height=${seq.height}" />
    <title>${seq.name}</title>
${head}
    <style>
      html, body { margin: 0; padding: 0; background: #000000; }
      #root { position: relative; width: ${seq.width}px; height: ${seq.height}px; overflow: hidden; background: #000000; }
      .layer { position: absolute; left: 0; top: 0; width: ${seq.width}px; height: ${seq.height}px; }
      .land { position: absolute; left: 60px; top: 690px; width: 960px; height: 540px; object-fit: fill; }
      .full { position: absolute; left: 0; top: 0; width: ${seq.width}px; height: ${seq.height}px; object-fit: fill; }
      .host { position: absolute; left: 0; top: 0; width: ${seq.width}px; height: ${seq.height}px; }
      .img-wrap { position: absolute; left: 0; top: 0; width: ${seq.width}px; height: ${seq.height}px; overflow: hidden; }
      .img-wrap img { position: absolute; left: 0; top: 0; width: ${seq.width}px; height: ${seq.height}px; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-width="${seq.width}" data-height="${seq.height}" data-duration="${durSec}"${fpsAttr}>
      <div id="track-V1" class="layer">
        ${v1.join('\n        ')}
      </div>
      <div id="track-V2" class="layer">
        ${v2.join('\n        ')}
      </div>
      <div id="track-captions" class="layer">
        ${captions}
      </div>
      <div id="track-A1">
        ${audio.join('\n        ')}
      </div>
    </div>
    <script>
      ${mainScript(ctx)}
    </script>
${ctx.templates.map((t) => `    ${t}`).join('\n')}
  </body>
</html>
`;
  build.files.set('index.html', html);
  build.files.set('sequence.json', `${JSON.stringify(seq, null, 2)}\n`);
  return build;
}

/** Absolute paths of the vendored files, from the pinned packages. */
export function vendorSources(): Record<string, string> {
  const req = createRequire(import.meta.url);
  const pkgDir = (name: string) => path.dirname(req.resolve(`${name}/package.json`));
  return {
    'gsap.min.js': path.join(pkgDir('gsap'), 'dist', 'gsap.min.js'),
    'hyperframe.runtime.iife.js': path.join(
      pkgDir('hyperframes'),
      'dist',
      'hyperframe.runtime.iife.js',
    ),
    'vox-runtime.js': path.join(TEMPLATES, 'vox-runtime.js'),
  };
}

/** Writes a build to `dir` (replaced). Media are hard-linked (copied across devices). */
export function writeBuild(build: Build, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of build.files) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  for (const [rel, from] of build.links) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    try {
      linkSync(from, p);
    } catch {
      copyFileSync(from, p);
    }
  }
  const vendor = vendorSources();
  mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  for (const name of build.vendor) {
    const from = vendor[name];
    if (!from) throw new Error(`no vendor source for ${name}`);
    copyFileSync(from, path.join(dir, 'vendor', name));
  }
}
