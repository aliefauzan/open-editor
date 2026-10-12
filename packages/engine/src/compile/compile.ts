// Compile: sequence → HyperFrames build, in memory (engine spec "Compile"; ported from the phase 01
// spike, GATE 1 / D-29). `writeBuild` (write.ts) puts it on disk.
//
// - render: `index.html` + one `scenes/<id>.html` per scene instance (`data-composition-src`);
//   originals, or the CFR copy of a VFR video; no `<audio>` (the picture is silent, phase 05 muxes
//   the ffmpeg mix); the HyperFrames CLI injects its runtime.
// - preview: one `index.html` with every instance inlined as `<template id="<id>-template">` (the
//   runtime mounts those without `fetch`, which the app's CSP blocks); proxies; `<audio>` for audio
//   clips and SFX; vendored runtime + `vox-preview.js`.
//
// Paint order is DOM order (HyperFrames ignores data-track-index): V1..Vn, each followed by its
// transition layer, then style overlays, then captions.
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';
import { cueList, cuesJson, type CueList } from '../audio/cues.ts';
import { VoxError } from '../errors.ts';
import {
  captionsToSrt,
  deriveCaptions,
  type CaptionChunk,
  type TranscriptOf,
} from '../model/captions.ts';
import { blendHalf, frame, type Fps } from '../model/fps.ts';
import { speedOf } from '../model/speed.ts';
import type {
  Item,
  Keyframe,
  MediaClip,
  MediaItem,
  Project,
  SceneClip,
  Sequence,
} from '../model/schema.ts';
import { checkRelativePath } from '../paths.ts';
import { cropSize } from '../stages/facetrack.ts';
import { registryTemplateLookup } from '../styles/lookup.ts';
import type { ResolvedStyle, StyleRegistry, TemplateDef } from '../styles/registry.ts';
import { captionSafeArea, variablesValidator } from '../styles/schema.ts';
import { tokensCss } from '../styles/tokens.ts';
import { facesFor, fontFaceCss, type FontFace } from './fonts.ts';
import { runHook, runMigrate } from './hooks.ts';

export type CompileMode = 'preview' | 'render';

export interface CompileOptions {
  mode: CompileMode;
  /** Timeline window to build (ms); the build starts at `startMs`. */
  range?: { startMs: number; endMs: number };
  /**
   * Only these layers, over a transparent background (`renderLayers`; render mode): scene item ids,
   * transition instances (`<itemId>-tx`), overlays (`overlay-<name>`) and `captions`. Media clips are
   * left out.
   */
  layers?: string[];
  /** `false` leaves the caption layer out (`render --captions none`); default true. */
  captions?: boolean;
}

/**
 * Crop keyframes for a `facetrack` or `auto` clip, item-relative (D-24). Phase 04 builds the path,
 * phase 05 plugs it in; without a provider the clip's own keyframes (or its static crop) are used.
 */
export type FramingProvider = (
  media: MediaItem,
  clip: MediaClip,
  sequence: Sequence,
) => readonly Keyframe[] | undefined;

export interface CompileInput {
  project: Project;
  /** Absolute project folder (media paths are relative to it). */
  projectDir: string;
  sequenceId: string;
  registry: StyleRegistry;
  transcriptOf: TranscriptOf;
  framing?: FramingProvider;
}

export interface BuildResult {
  sequenceId: string;
  /** Absolute project folder (writeBuild writes to `build/<sequenceId>/` in it). */
  projectDir: string;
  mode: CompileMode;
  /** Sequence frame rate (the render `--fps`). */
  fps: Fps;
  /** Build-relative path → text content. */
  files: Map<string, string | Uint8Array>;
  /** Build-relative path → absolute source file (hard-linked, or copied across devices). */
  links: Map<string, string>;
  /** Vendored files, `vendor/<name>`. */
  vendor: string[];
  durationMs: number;
  captions: CaptionChunk[];
  cues: CueList;
  warnings: string[];
}

/** Preview only: +1 ms on video `data-media-start` (Chromium truncates seeks; phase 01, D-29). */
export const PREVIEW_VIDEO_BIAS_S = 0.001;

const json = (v: unknown): string =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n: number): string => String(Math.round(n * 1000) / 1000);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const trackNo = (id: string) => Number(id.slice(1));
const endOf = (i: Item) => i.startMs + i.durationMs;

const templateCache = new Map<string, string>();
/** The inner HTML of a template file's `<template>` block. */
export function templateInner(file: string): string {
  let t = templateCache.get(file);
  if (t === undefined) {
    const html = readFileSync(file, 'utf8');
    const a = html.indexOf('<template>');
    const b = html.lastIndexOf('</template>');
    if (a < 0 || b < a) {
      throw new VoxError(
        'STYLE_INVALID',
        `${file} has no <template> block`,
        'Wrap the template markup in <template>…</template>',
        { details: { file, reason: 'template-html' } },
      );
    }
    t = html.slice(a + '<template>'.length, b);
    templateCache.set(file, t);
  }
  return t;
}

/** Clears the template file cache (tests that rewrite template files). */
export function clearTemplateCache(): void {
  templateCache.clear();
}

function majorOf(v: string): number {
  return Number(v.split('.')[0]);
}

function mediaMissing(id: string, itemId?: string): VoxError {
  return new VoxError(
    'MEDIA_MISSING',
    `Media ${id} is not in the project library`,
    'Re-add the media or remove the item that uses it',
    { details: { mediaId: id, ...(itemId ? { itemId } : {}) } },
  );
}

interface Ctx {
  input: CompileInput;
  seq: Sequence;
  mode: CompileMode;
  fps: Fps;
  seqStyle: ResolvedStyle;
  build: BuildResult;
  media: Map<string, MediaItem>;
  /** Preview: `<template id>` blocks collected at document level. */
  templates: string[];
  /** Styles whose tokens are emitted (fonts) and whose assets are linked. */
  tokenStyles: Map<string, ResolvedStyle>;
  /** Main timeline lines (GSAP). */
  script: string[];
  /** `layers` option: the ids to keep; the ids kept so far. */
  only?: Set<string>;
  kept: Set<string>;
}

/** Whether layer `id` is emitted (always, without the `layers` option). */
function keep(ctx: Ctx, id: string): boolean {
  if (ctx.only && !ctx.only.has(id)) return false;
  ctx.kept.add(id);
  return true;
}

const secOf = (ctx: Ctx, t: number): string => {
  const f = frame(t, ctx.fps);
  return String((f * ctx.fps.den) / ctx.fps.num);
};

/** Path as seen from an instance file: `scenes/` in render, the index in preview. */
const scenePath = (ctx: Ctx, rel: string): string => (ctx.mode === 'render' ? `../${rel}` : rel);

function safeExt(p: string): string {
  const e = extname(p).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(e) ? e : '';
}

function projectFile(ctx: Ctx, rel: string): string {
  if (!checkRelativePath(rel)) {
    throw new VoxError(
      'PATH_INVALID',
      `Media path ${JSON.stringify(rel)} is not project-relative`,
      'Fix the media path in project.json',
      { details: { path: rel } },
    );
  }
  return join(ctx.input.projectDir, rel);
}

function link(ctx: Ctx, rel: string, abs: string): string {
  ctx.build.links.set(rel, abs);
  return rel;
}

function mediaOf(ctx: Ctx, id: string, itemId?: string): MediaItem {
  const m = ctx.media.get(id);
  if (!m) throw mediaMissing(id, itemId);
  return m;
}

/**
 * Build path of the picture file of a media item for this mode. A VFR video never plays from its
 * original (D-15): render uses the CFR copy, preview the proxy (made from the CFR copy) or the copy.
 */
function pictureFile(ctx: Ctx, m: MediaItem): string {
  const cfrOrPath = m.vfr && m.cfrPath ? m.cfrPath : m.path;
  const rel =
    m.kind === 'video' ? (ctx.mode === 'render' ? cfrOrPath : (m.proxyPath ?? cfrOrPath)) : m.path;
  return link(ctx, `media/${m.id}${safeExt(rel)}`, projectFile(ctx, rel));
}

function audioFile(ctx: Ctx, m: MediaItem): string {
  const rel = m.audioPath ?? m.path;
  return link(ctx, `audio/${m.id}${safeExt(rel)}`, projectFile(ctx, rel));
}

/** Tokens for a template of `declaring` used in this sequence (styles spec "Tokens"). */
function tokenStyle(ctx: Ctx, declaring: string): ResolvedStyle {
  const s = ctx.seqStyle.chain.includes(declaring)
    ? ctx.seqStyle
    : ctx.input.registry.get(declaring);
  ctx.tokenStyles.set(s.id, s);
  return s;
}

function tokensBlock(ctx: Ctx, s: ResolvedStyle): string {
  const css = tokensCss(s.style.tokens, '#root', {
    assetUrl: (_t, p) => {
      const abs = s.files.texture?.paper;
      if (abs) link(ctx, `styles/${s.id}/${p}`, abs);
      return scenePath(ctx, `styles/${s.id}/${p}`);
    },
  });
  return `<style>\n${css}</style>`;
}

function varsBlock(id: string, vars: unknown): string {
  return `<script type="application/json" data-vox-vars data-vox-instance="${attr(id)}">${json(vars)}</script>`;
}

/**
 * One instance: a per-instance file (render) or a document-level `<template>` (preview). Returns
 * the host attribute that points at it.
 */
function emitInstance(
  ctx: Ctx,
  id: string,
  htmlPath: string,
  style: ResolvedStyle,
  vars: unknown,
  durMs: number,
  extra: [string, string][] = [],
  size: { width: number; height: number } = ctx.seq.canvas,
): string {
  let inner = templateInner(htmlPath)
    .replaceAll('__ID__', id)
    .replaceAll('__DUR__', secOf(ctx, durMs))
    .replaceAll('__W__', String(size.width))
    .replaceAll('__H__', String(size.height))
    .replace('<!--vox:tokens-->', () => tokensBlock(ctx, style))
    .replace('<!--vox:vars-->', () => varsBlock(id, vars));
  for (const [k, v] of extra) inner = inner.replace(k, () => v);
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

function requireDef(ctx: Ctx, templateId: string, itemId: string): TemplateDef {
  const def = ctx.input.registry.template(templateId);
  if (!def) {
    throw new VoxError(
      'TEMPLATE_UNKNOWN',
      `Template ${templateId} is not installed`,
      'Install the style that declares it, or replace the item',
      { details: { template: templateId, itemId } },
    );
  }
  return def;
}

function versionError(def: TemplateDef, itemId: string, placed: string): VoxError {
  return new VoxError(
    'TEMPLATE_VERSION',
    `${itemId} was placed with ${def.id} ${placed}; the installed version is ${def.version}`,
    'Re-place the scene with the installed template (its variables may have changed)',
    { details: { template: def.id, itemId, placed, installed: def.version } },
  );
}

/**
 * A scene's variables for the installed template. Across a major version they go through the
 * template's `migrate(variables, fromVersion)` export (trusted styles only, S8; an untrusted hook is
 * never loaded: `HOOK_UNTRUSTED`); without one, `TEMPLATE_VERSION`. Migrated variables must match
 * the installed variables schema (`VARIABLES_INVALID`).
 */
async function placedVariables(
  ctx: Ctx,
  s: SceneClip,
): Promise<{ def: TemplateDef; vars: Record<string, unknown> }> {
  const def = requireDef(ctx, s.template, s.id);
  const placed = s.templateVersion;
  if (placed === undefined || majorOf(placed) === majorOf(def.version)) {
    return { def, vars: s.variables };
  }
  const migrated = await runMigrate(def, s.variables, placed);
  if (migrated === undefined) throw versionError(def, s.id, placed);
  const validate = variablesValidator(def.variables as Record<string, unknown>);
  if (!validate(migrated)) {
    throw new VoxError(
      'VARIABLES_INVALID',
      `${s.id}: variables migrated from ${def.id} ${placed} do not match ${def.version}`,
      'Fix migrate() in the template hook, or re-place the scene',
      { details: { template: def.id, itemId: s.id, placed, errors: validate.errors ?? [] } },
    );
  }
  return { def, vars: migrated };
}

function mapSlot(v: unknown, segs: string[], fn: (x: unknown) => unknown): unknown {
  if (segs.length === 0) return fn(v);
  const [h, ...rest] = segs as [string, ...string[]];
  if (h === '*') return Array.isArray(v) ? v.map((e) => mapSlot(e, rest, fn)) : v;
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && h in v) {
    return {
      ...(v as Record<string, unknown>),
      [h]: mapSlot((v as Record<string, unknown>)[h], rest, fn),
    };
  }
  return v;
}

/** Scene variables with media slots resolved to build paths; template slots left for panels. */
function resolveMediaSlots(
  ctx: Ctx,
  def: TemplateDef,
  vars: Record<string, unknown>,
  itemId: string,
) {
  let out: unknown = vars;
  for (const [path, kind] of Object.entries(def.slots).sort(([a], [b]) => cmp(a, b))) {
    if (kind !== 'image' && kind !== 'cutout' && kind !== 'video') continue;
    out = mapSlot(out, path.split('/'), (x) =>
      typeof x === 'string' ? scenePath(ctx, pictureFile(ctx, mediaOf(ctx, x, itemId))) : x,
    );
  }
  return out as Record<string, unknown>;
}

async function sceneVars(
  ctx: Ctx,
  def: TemplateDef,
  id: string,
  variables: Record<string, unknown>,
  durationMs: number,
): Promise<Record<string, unknown>> {
  let vars = resolveMediaSlots(ctx, def, variables, id);
  if (def.minEntranceMs !== undefined && durationMs < def.minEntranceMs) {
    vars = { ...vars, skipEntrance: true };
  }
  if (def.hookPath) {
    const styleDir = ctx.input.registry.get(def.styleId).dir;
    const r = await runHook(def, styleDir, vars, id, (name) =>
      scenePath(ctx, `scenes/${id}.files/${name}`),
    );
    vars = r.vars;
    for (const [name, content] of r.files)
      ctx.build.files.set(`scenes/${id}.files/${name}`, content);
  }
  return vars;
}

/**
 * Canvas of a nested panel (D-71): the sequence canvas, or with a template's `panelAspect` ("a:b") the
 * canvas width and the height of that ratio, rounded to an even number of pixels.
 */
export function panelSize(
  canvas: { width: number; height: number },
  aspect: string | undefined,
): { width: number; height: number } {
  if (aspect === undefined) return { width: canvas.width, height: canvas.height };
  const [a, b] = aspect.split(':').map(Number) as [number, number];
  return { width: canvas.width, height: 2 * Math.round((canvas.width * b) / a / 2) };
}

/** Nested panels of `template` slots (depth 1): one host per panel at `<!--vox:panels-->`. */
async function panelHosts(
  ctx: Ctx,
  def: TemplateDef,
  host: SceneClip,
  durMs: number,
): Promise<string[]> {
  const hosts: string[] = [];
  const { width: W, height: H } = panelSize(ctx.seq.canvas, def.panelAspect);
  for (const [path, kind] of Object.entries(def.slots).sort(([a], [b]) => cmp(a, b))) {
    if (kind !== 'template') continue;
    const panels: unknown[] = [];
    mapSlot(host.variables, path.split('/'), (x) => {
      panels.push(x);
      return x;
    });
    for (const p of panels.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
      if (p === null || typeof p !== 'object') continue;
      const { template, variables } = p as { template?: unknown; variables?: unknown };
      if (typeof template !== 'string') continue;
      const k = hosts.length;
      const id = `${host.id}-p${k}`;
      const pdef = requireDef(ctx, template, host.id);
      const vars = await sceneVars(
        ctx,
        pdef,
        id,
        (variables ?? {}) as Record<string, unknown>,
        durMs,
      );
      const src = emitInstance(
        ctx,
        id,
        pdef.htmlPath,
        tokenStyle(ctx, pdef.styleId),
        vars,
        durMs,
        [],
        { width: W, height: H },
      );
      // nested mounts: the path is project-relative like top-level mounts (phase 01 finding)
      hosts.push(
        `<div id="${id}" class="vox-panel" data-vox-panel="${k}" data-composition-id="${id}"${src} data-start="0" data-duration="${secOf(ctx, durMs)}" data-width="${W}" data-height="${H}"></div>`,
      );
    }
  }
  return hosts;
}

async function sceneHost(ctx: Ctx, s: SceneClip, trackIndex: number): Promise<string> {
  const placed = await placedVariables(ctx, s);
  const def = placed.def;
  const vars = await sceneVars(ctx, def, s.id, placed.vars, s.durationMs);
  const panels = await panelHosts(ctx, def, s, s.durationMs);
  const src = emitInstance(
    ctx,
    s.id,
    def.htmlPath,
    tokenStyle(ctx, def.styleId),
    vars,
    s.durationMs,
    panels.length ? [['<!--vox:panels-->', panels.join('\n')]] : [],
  );
  return `<div id="${s.id}" class="clip host" data-composition-id="${s.id}"${src} data-start="${secOf(ctx, s.startMs)}" data-duration="${secOf(ctx, s.durationMs)}" data-track-index="${trackIndex}" data-width="${ctx.seq.canvas.width}" data-height="${ctx.seq.canvas.height}"></div>`;
}

/** `data-playback-rate` of a clip with a speed (engine spec "Clip speed", plan D-62); none at 1×. */
const rateAttr = (it: MediaClip): string =>
  it.speed !== undefined && it.speed !== 1 ? ` data-playback-rate="${num(it.speed)}"` : '';

/** Media seconds of a source offset on the source's grid (sequence grid for media with no fps). */
function mediaStart(ctx: Ctx, m: MediaItem, inMs: number, bias: number): string {
  const fps = m.fps ?? ctx.fps;
  const f = frame(inMs, fps);
  return String((f * fps.den) / fps.num + bias);
}

interface Placed {
  item: MediaClip;
  startMs: number;
  inMs: number;
  durationMs: number;
}

const transformOf = (
  kf: { x: number; y: number; scale: number },
  vw: number,
  vh: number,
  W: number,
  H: number,
) => ({
  x: Math.round((W / 2 - kf.x * vw * kf.scale) * 1000) / 1000,
  y: Math.round((H / 2 - kf.y * vh * kf.scale) * 1000) / 1000,
  scale: Math.round(kf.scale * 100000) / 100000,
});

/** Inline style + GSAP lines for a clip's framing (engine spec "Shots and framing", D-24). */
function framing(ctx: Ctx, m: MediaItem, p: Placed): string {
  const W = ctx.seq.canvas.width;
  const H = ctx.seq.canvas.height;
  const fr = p.item.frame;
  const mode = fr?.mode ?? 'cover';
  const fit = (f: 'cover' | 'contain') =>
    `position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: ${f};`;
  if (mode === 'cover' || mode === 'contain') return fit(mode);
  if (!m.width || !m.height) {
    ctx.build.warnings.push(`${p.item.id}: ${m.id} has no size; framed as cover`);
    return fit('cover');
  }
  let kfs: readonly Keyframe[] | undefined;
  if (mode === 'facetrack' || mode === 'auto') {
    kfs = ctx.input.framing?.(m, p.item, ctx.seq) ?? fr?.keyframes;
  } else kfs = fr?.keyframes;
  const crop = cropSize({ width: m.width, height: m.height }, { width: W, height: H }, 1);
  const vw = W / crop.w;
  const vh = H / crop.h;
  const base = `position: absolute; left: 0; top: 0; width: ${num(vw)}px; height: ${num(vh)}px; object-fit: fill; transform-origin: 0 0;`;
  const list =
    kfs && kfs.length > 0
      ? [...kfs].sort((a, b) => a.atMs - b.atMs)
      : [{ atMs: 0, x: fr?.x ?? 0.5, y: fr?.y ?? 0.5, scale: fr?.scale ?? 1 }];
  const t0 = transformOf(list[0]!, vw, vh, W, H);
  const style = `${base} transform: translate(${t0.x}px, ${t0.y}px) scale(${t0.scale});`;
  if (list.length > 1) {
    // keyframes are item-relative; a crossfade's early start shifts the element, not the path
    const at = (k: Keyframe) =>
      (frame(p.item.startMs + k.atMs, ctx.fps) * ctx.fps.den) / ctx.fps.num;
    // One script line per clip: steps are [position, x, y, scale, duration]; duration 0 = a set.
    // A line per keyframe pushed long clips past hyperframes' 300-line lint limit (`--strict-all`).
    const steps = [`[${num(at(list[0]!))}, ${t0.x}, ${t0.y}, ${t0.scale}, 0]`];
    for (let i = 1; i < list.length; i++) {
      const t = transformOf(list[i]!, vw, vh, W, H);
      const a = at(list[i - 1]!);
      const d = at(list[i]!) - a;
      steps.push(
        d <= 0
          ? `[${num(at(list[i]!))}, ${t.x}, ${t.y}, ${t.scale}, 0]`
          : `[${num(a)}, ${t.x}, ${t.y}, ${t.scale}, ${num(d)}]`,
      );
    }
    ctx.script.push(`voxPath('${p.item.id}', [${steps.join(', ')}]);`);
  }
  return style;
}

function videoTag(ctx: Ctx, m: MediaItem, p: Placed, trackIndex: number): string {
  const src = pictureFile(ctx, m);
  const bias = ctx.mode === 'preview' ? PREVIEW_VIDEO_BIAS_S : 0;
  return `<video id="${p.item.id}" src="${attr(src)}" style="${framing(ctx, m, p)}" data-start="${secOf(ctx, p.startMs)}" data-duration="${secOf(ctx, p.durationMs)}" data-media-start="${mediaStart(ctx, m, p.inMs, bias)}"${rateAttr(p.item)} data-track-index="${trackIndex}" muted playsinline></video>`;
}

function imageTag(ctx: Ctx, m: MediaItem, p: Placed, trackIndex: number): string {
  const W = ctx.seq.canvas.width;
  const H = ctx.seq.canvas.height;
  const src = pictureFile(ctx, m);
  const motion = p.item.motion;
  let style = framing(ctx, m, p);
  if (motion && motion.type !== 'none' && motion.amount !== 0) {
    const a = Math.abs(motion.amount);
    const d = secOf(ctx, p.durationMs);
    const at = secOf(ctx, p.startMs);
    style = `position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: cover;`;
    if (motion.type === 'push-in') {
      ctx.script.push(
        `tl.fromTo(byId('${p.item.id}'), { scale: 1 }, { scale: ${num(1 + a)}, duration: ${d}, ease: 'none' }, ${at});`,
      );
    } else {
      const dx = num(-motion.amount * W * 0.5);
      ctx.script.push(
        `tl.fromTo(byId('${p.item.id}'), { scale: ${num(1 + a)}, x: 0 }, { scale: ${num(1 + a)}, x: ${dx}, duration: ${d}, ease: 'none' }, ${at});`,
      );
    }
  }
  // untimed crop wrapper; the timed <img> carries the transform
  return `<div class="img-wrap"><img id="${p.item.id}" class="clip" src="${attr(src)}" alt="" style="${style}" data-start="${secOf(ctx, p.startMs)}" data-duration="${secOf(ctx, p.durationMs)}" data-track-index="${trackIndex}" /></div>`;
}

/** Media clip placements of a track, with crossfades overlapping the shots (D-12). */
function placements(ctx: Ctx, items: readonly Item[]): Map<string, Placed> {
  const out = new Map<string, Placed>();
  for (const it of items) {
    if (it.type === 'media') {
      out.set(it.id, { item: it, startMs: it.startMs, inMs: it.inMs, durationMs: it.durationMs });
    }
  }
  if (ctx.only) return out; // media clips are not in a layers build
  for (const it of items) {
    const tr = it.transitionIn;
    if (!tr) continue;
    const def = ctx.input.registry.template(tr.template);
    if (!def?.blendsShots) continue;
    const { before, after } = blendHalf(it.startMs, tr.durationMs, ctx.seq.canvas.fps);
    const inc = out.get(it.id);
    if (inc) {
      // the early start shows source before inMs at the clip's speed (plan D-62)
      const sp = speedOf(inc.item);
      const shift = Math.min(before, Math.floor(inc.inMs / sp), inc.startMs);
      inc.startMs -= shift;
      inc.inMs -= Math.round(shift * sp);
      inc.durationMs += shift;
    }
    const prev = items.find((x) => endOf(x) === it.startMs);
    const out1 = prev ? out.get(prev.id) : undefined;
    if (out1) out1.durationMs += after;
    const start = inc ? inc.startMs : it.startMs;
    ctx.script.push(
      `tl.fromTo(byId('${it.id}'), { opacity: 0 }, { opacity: 1, duration: ${secOf(ctx, tr.durationMs)}, ease: 'none' }, ${secOf(ctx, start)});`,
    );
  }
  return out;
}

async function videoLayer(ctx: Ctx, track: Sequence['videoTracks'][number]): Promise<string[]> {
  const k = trackNo(track.id);
  const items = [...track.items].sort((a, b) => a.startMs - b.startMs || cmp(a.id, b.id));
  const placed = placements(ctx, items);
  const out: string[] = [];
  for (const it of items) {
    if (ctx.only && (it.type !== 'scene' || !keep(ctx, it.id))) continue;
    if (it.type === 'scene') {
      out.push(await sceneHost(ctx, it, k));
      continue;
    }
    const m = mediaOf(ctx, it.mediaId, it.id);
    const p = placed.get(it.id)!;
    if (m.kind === 'image') out.push(imageTag(ctx, m, p, k));
    else if (m.kind === 'video') out.push(videoTag(ctx, m, p, k));
    else {
      throw new VoxError(
        'TRACK_KIND',
        `${it.id} on ${track.id} uses ${m.kind} media ${m.id}`,
        'Video tracks hold video and image clips and scenes',
        { details: { itemId: it.id, mediaId: m.id } },
      );
    }
  }
  return out;
}

async function transitionLayer(
  ctx: Ctx,
  track: Sequence['videoTracks'][number],
): Promise<string[]> {
  const k = trackNo(track.id);
  const out: string[] = [];
  const items = [...track.items].sort((a, b) => a.startMs - b.startMs || cmp(a.id, b.id));
  for (const it of items) {
    const tr = it.transitionIn;
    if (!tr) continue;
    const def = requireDef(ctx, tr.template, it.id);
    const id = `${it.id}-tx`;
    if (!keep(ctx, id)) continue;
    const { before } = blendHalf(it.startMs, tr.durationMs, ctx.seq.canvas.fps);
    const start = Math.max(0, it.startMs - before);
    const src = emitInstance(
      ctx,
      id,
      def.htmlPath,
      tokenStyle(ctx, def.styleId),
      {},
      tr.durationMs,
    );
    out.push(
      `<div id="${id}" class="clip host" data-composition-id="${id}"${src} data-start="${secOf(ctx, start)}" data-duration="${secOf(ctx, tr.durationMs)}" data-track-index="${k}" data-width="${ctx.seq.canvas.width}" data-height="${ctx.seq.canvas.height}"></div>`,
    );
  }
  return out;
}

function overlayLayer(ctx: Ctx, durMs: number): string[] {
  const names =
    ctx.seq.overlays ?? ctx.seqStyle.overlays.filter((o) => o.default).map((o) => o.name);
  const out: string[] = [];
  for (const name of names) {
    const o = ctx.seqStyle.overlays.find((x) => x.name === name);
    if (!o) {
      ctx.build.warnings.push(`overlay ${name} is not in style ${ctx.seqStyle.id}; skipped`);
      continue;
    }
    const id = `overlay-${name}`;
    if (!keep(ctx, id)) continue;
    const src = emitInstance(ctx, id, o.htmlPath, tokenStyle(ctx, o.styleId), {}, durMs);
    out.push(
      `<div id="${id}" class="clip host" data-composition-id="${id}"${src} data-start="0" data-duration="${secOf(ctx, durMs)}" data-track-index="90" data-width="${ctx.seq.canvas.width}" data-height="${ctx.seq.canvas.height}"></div>`,
    );
  }
  return out;
}

const PUNCT = /[\p{P}]+/gu;

/** The preset's `case` / `stripPunctuation` applied to word text (D-15); SRT never gets this. */
export function presetText(
  chunks: readonly CaptionChunk[],
  preset: { case: 'asis' | 'upper' | 'lower'; stripPunctuation: boolean },
): CaptionChunk[] {
  const f = (t: string) => {
    let s = preset.stripPunctuation ? t.replace(PUNCT, '') : t;
    if (preset.case === 'upper') s = s.toUpperCase();
    else if (preset.case === 'lower') s = s.toLowerCase();
    return s;
  };
  return chunks.map((c) => ({
    ...c,
    lines: c.lines.map((l) => ({
      words: l.words.map((w) => ({ ...w, text: f(w.text) })).filter((w) => w.text !== ''),
    })),
  }));
}

function captionLayer(ctx: Ctx, chunks: CaptionChunk[], durMs: number): string {
  const cap = ctx.seq.captions;
  if (!cap?.enabled || chunks.length === 0) return '';
  const presetStyle = cap.preset.split('/')[0]!;
  const owner = ctx.seqStyle.captionPresets[cap.preset]
    ? ctx.seqStyle
    : ctx.input.registry.get(presetStyle);
  const preset = owner.captionPresets[cap.preset];
  if (!preset) {
    throw new VoxError(
      'TEMPLATE_UNKNOWN',
      `Caption preset ${cap.preset} is not installed`,
      'Pick a preset listed by the style (`style.captions.presets`)',
      { details: { template: cap.preset } },
    );
  }
  const vars = {
    chunks: presetText(chunks, preset),
    position: { yPct: cap.position.yPct },
    safeArea: captionSafeArea(preset, ctx.seq.canvas),
    maxCharsPerLine: cap.maxCharsPerLine,
  };
  const src = emitInstance(
    ctx,
    'captions',
    preset.htmlPath,
    tokenStyle(ctx, preset.styleId),
    vars,
    durMs,
  );
  return `<div id="captions" class="clip host" data-composition-id="captions"${src} data-track-kind="captions" data-start="0" data-duration="${secOf(ctx, durMs)}" data-track-index="99" data-width="${ctx.seq.canvas.width}" data-height="${ctx.seq.canvas.height}"></div>`;
}

/** Preview `<audio>`: audio-track clips (muted tracks skipped) and kept SFX cues. */
function audioLayer(ctx: Ctx, cues: CueList, durMs: number): string[] {
  if (ctx.mode === 'render') return [];
  const out: string[] = [];
  const tracks = [...ctx.seq.audioTracks].sort((a, b) => trackNo(a.id) - trackNo(b.id));
  for (const t of tracks) {
    if (t.muted) continue;
    const k = trackNo(t.id);
    for (const it of [...t.items].sort((a, b) => a.startMs - b.startMs || cmp(a.id, b.id))) {
      if (it.type !== 'media') continue;
      const m = mediaOf(ctx, it.mediaId, it.id);
      const src = audioFile(ctx, m);
      const vol = Math.min(1, Math.max(0, it.volume ?? 1));
      out.push(
        `<audio id="${it.id}" src="${attr(src)}" data-start="${secOf(ctx, it.startMs)}" data-duration="${secOf(ctx, it.durationMs)}" data-media-start="${mediaStart(ctx, m, it.inMs, 0)}"${rateAttr(it)} data-volume="${num(vol)}" data-track-index="${100 + k}"></audio>`,
      );
      if (it.fadeInMs) {
        ctx.script.push(
          `tl.fromTo(byId('${it.id}'), { volume: 0 }, { volume: ${num(vol)}, duration: ${secOf(ctx, it.fadeInMs)}, ease: 'none' }, ${secOf(ctx, it.startMs)});`,
        );
      }
      if (it.fadeOutMs) {
        ctx.script.push(
          `tl.fromTo(byId('${it.id}'), { volume: ${num(vol)} }, { volume: 0, duration: ${secOf(ctx, it.fadeOutMs)}, ease: 'none' }, ${secOf(ctx, endOf(it) - it.fadeOutMs)});`,
        );
      }
    }
  }
  if (!ctx.seq.sfx) return out;
  cues.cues.forEach((c, i) => {
    const abs = ctx.seqStyle.files.sfx[c.sfx];
    if (!abs) {
      ctx.build.warnings.push(
        `sfx ${c.sfx} is not in style ${ctx.seqStyle.id}; cue ${c.cueName} skipped`,
      );
      return;
    }
    const src = link(ctx, `sfx/${ctx.seqStyle.id}/${c.sfx}${safeExt(abs)}`, abs);
    const d = Math.min(3000, durMs - c.atMs);
    if (d <= 0) return;
    out.push(
      `<audio id="sfx-${i}" src="${attr(src)}" data-start="${secOf(ctx, c.atMs)}" data-duration="${secOf(ctx, d)}" data-media-start="0" data-volume="1" data-track-index="199"></audio>`,
    );
  });
  return out;
}

/** The sequence cut to `range` and shifted to start at 0; scenes and transitions cut at the start are dropped. */
export function applyRange(
  s: Sequence,
  range: { startMs: number; endMs: number },
  warnings: string[],
): Sequence {
  const { startMs: a, endMs: b } = range;
  if (!(b > a) || a < 0) {
    throw new VoxError(
      'VALIDATION',
      `Bad range ${a}–${b}`,
      'Pass a range with 0 ≤ startMs < endMs',
    );
  }
  const cut = <T extends { items: Item[] }>(t: T): T => ({
    ...t,
    items: t.items.flatMap((it): Item[] => {
      const e = endOf(it);
      if (e <= a || it.startMs >= b) return [];
      const head = Math.max(0, a - it.startMs);
      if (head > 0 && it.type === 'scene') {
        warnings.push(`${it.id}: scene starts before the range; dropped`);
        return [];
      }
      const next: Item = {
        ...it,
        startMs: it.startMs + head - a,
        durationMs: Math.min(e, b) - it.startMs - head,
      };
      if (next.type === 'media') next.inMs += Math.round(head * speedOf(next));
      if (
        next.transitionIn &&
        (head > 0 ||
          it.startMs - blendHalf(it.startMs, next.transitionIn.durationMs, s.canvas.fps).before < a)
      ) {
        warnings.push(`${it.id}: transition cut by the range start; dropped`);
        delete next.transitionIn;
      }
      return [next];
    }),
  });
  return { ...s, videoTracks: s.videoTracks.map(cut), audioTracks: s.audioTracks.map(cut) };
}

function shiftChunks(chunks: CaptionChunk[], a: number, b: number): CaptionChunk[] {
  return chunks
    .filter((c) => c.endMs > a && c.startMs < b)
    .map((c) => ({
      startMs: Math.max(0, c.startMs - a),
      endMs: Math.min(b, c.endMs) - a,
      lines: c.lines.map((l) => ({
        words: l.words
          .filter((w) => w.endMs > a && w.startMs < b)
          .map((w) => ({
            ...w,
            startMs: Math.max(0, w.startMs - a),
            endMs: Math.min(b, w.endMs) - a,
          })),
      })),
    }));
}

/** Absolute vendored source files (pinned packages + the engine's runtime helpers). */
export const VENDOR_RENDER = ['gsap.min.js', 'vox-runtime.js'] as const;
export const VENDOR_PREVIEW = [
  ...VENDOR_RENDER,
  'hyperframe.runtime.iife.js',
  'vox-preview.js',
] as const;

export async function compileSequence(
  input: CompileInput,
  opts: CompileOptions,
): Promise<BuildResult> {
  const original = input.project.sequences.find((x) => x.id === input.sequenceId);
  if (!original) {
    throw new VoxError(
      'NOT_FOUND',
      `Sequence ${input.sequenceId} not found`,
      'Use a sequence id from the project',
      {
        details: { sequenceId: input.sequenceId },
      },
    );
  }
  if (opts.layers && opts.mode !== 'render') {
    throw new VoxError(
      'VALIDATION',
      'Layers are rendered from a render build',
      'Compile with mode render',
    );
  }
  const warnings: string[] = [];
  const seq = opts.range ? applyRange(original, opts.range, warnings) : original;
  const fps = seq.canvas.fps;
  const lookup = registryTemplateLookup(() => input.registry);
  const ends = [...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.items.map(endOf));
  const lastEnd = ends.length ? Math.max(...ends) : 0;
  const durationMs = opts.range ? opts.range.endMs - opts.range.startMs : lastEnd;
  if (durationMs <= 0 || lastEnd <= 0) {
    throw new VoxError(
      'VALIDATION',
      `Sequence ${seq.id} is empty`,
      'Add clips or scenes before compiling',
      {
        details: { sequenceId: seq.id },
      },
    );
  }
  let captions = deriveCaptions(input.project, original.id, input.transcriptOf);
  if (opts.range) captions = shiftChunks(captions, opts.range.startMs, opts.range.endMs);
  const cues = cueList(seq, lookup);
  if (opts.range) {
    cues.cues = cues.cues.filter((c) => c.atMs < durationMs);
  }
  const build: BuildResult = {
    sequenceId: seq.id,
    projectDir: input.projectDir,
    mode: opts.mode,
    fps: seq.canvas.fps,
    files: new Map(),
    links: new Map(),
    vendor: [...(opts.mode === 'preview' ? VENDOR_PREVIEW : VENDOR_RENDER)],
    durationMs,
    captions,
    cues,
    warnings,
  };
  const ctx: Ctx = {
    input,
    seq,
    mode: opts.mode,
    fps,
    seqStyle: input.registry.get(seq.styleId),
    build,
    media: new Map(input.project.media.map((m) => [m.id, m])),
    templates: [],
    tokenStyles: new Map(),
    script: [],
    ...(opts.layers ? { only: new Set(opts.layers) } : {}),
    kept: new Set(),
  };

  const layers: string[] = [];
  const tracks = [...seq.videoTracks].sort((a, b) => trackNo(a.id) - trackNo(b.id));
  for (const t of tracks) {
    if (t.hidden) continue;
    const items = await videoLayer(ctx, t);
    layers.push(layerDiv(`track-${t.id}`, items));
    const tx = await transitionLayer(ctx, t);
    if (tx.length) layers.push(layerDiv(`track-${t.id}-tx`, tx));
  }
  const overlays = overlayLayer(ctx, durationMs);
  if (overlays.length) layers.push(layerDiv('track-overlays', overlays));
  const cap =
    opts.captions !== false && keep(ctx, 'captions') ? captionLayer(ctx, captions, durationMs) : '';
  if (cap) layers.push(layerDiv('track-captions', [cap]));
  else ctx.kept.delete('captions');
  const missing = [...(ctx.only ?? [])].filter((id) => !ctx.kept.has(id));
  if (missing.length) {
    throw new VoxError(
      'VALIDATION',
      `No layer ${missing.join(', ')} in sequence ${seq.id}`,
      'Pick scene item ids, <itemId>-tx transitions, overlay-<name> overlays or captions',
      { details: { layers: missing } },
    );
  }
  const audio = audioLayer(ctx, cues, durationMs);
  if (audio.length) layers.push(`<div id="track-audio">\n${indent(audio, 8)}\n      </div>`);

  // fonts of every style whose tokens are emitted; each used style's assets/ folder
  const faces = new Map<string, FontFace>();
  for (const s of [...ctx.tokenStyles.values()].sort((a, b) => cmp(a.id, b.id))) {
    for (const role of ['display', 'body', 'caption'] as const) {
      const f = s.style.tokens.fonts[role];
      for (const face of facesFor(f.family, s.files.fonts[role], f.weight, s.id)) {
        faces.set(`${face.family}\0${face.url}`, face);
      }
    }
    for (const id of s.chain) linkStyleAssets(ctx, input.registry.get(id));
  }
  const faceList = [...faces.values()].sort((a, b) => cmp(a.url, b.url) || cmp(a.family, b.family));
  for (const f of faceList) link(ctx, f.url, f.file);

  const bg = ctx.only ? 'transparent' : '#000000';
  const W = seq.canvas.width;
  const H = seq.canvas.height;
  const head = build.vendor.map((v) => `    <script src="vendor/${v}"></script>`).join('\n');
  const fpsAttr = fps.den === 1 ? ` data-fps="${fps.num}"` : '';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${text(seq.name)}</title>
${head}
    <style>
${fontFaceCss(faceList)}
      html, body { margin: 0; padding: 0; background: ${bg}; }
      #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${bg}; }
      .layer { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
      .host { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; }
      .img-wrap { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-width="${W}" data-height="${H}" data-duration="${secOf(ctx, durationMs)}"${fpsAttr}>
      ${layers.join('\n      ')}
    </div>
    <script>
      (function () {
        var byId = function (id) { return document.getElementById(id); };
        var tl = gsap.timeline({ paused: true });
        var voxPath = function (id, steps) {
          var el = byId(id);
          steps.forEach(function (s) {
            var v = { x: s[1], y: s[2], scale: s[3] };
            if (s[4] > 0) { v.duration = s[4]; v.ease = 'none'; tl.to(el, v, s[0]); }
            else tl.set(el, v, s[0]);
          });
        };
${indent(ctx.script, 8)}
        window.__timelines['main'] = tl;
      })();
    </script>
${ctx.templates.map((t) => `    ${t}`).join('\n')}
  </body>
</html>
`;
  build.files.set('index.html', html);
  build.files.set('audio/cues.json', cuesJson(cues));
  build.files.set('captions.srt', captionsToSrt(captions));
  return build;
}

function indent(lines: readonly string[], n: number): string {
  const pad = ' '.repeat(n);
  return lines.map((l) => `${pad}${l}`).join('\n');
}

function layerDiv(id: string, items: readonly string[]): string {
  return `<div id="${id}" class="layer">\n${indent(items, 8)}\n      </div>`;
}

function linkStyleAssets(ctx: Ctx, s: ResolvedStyle): void {
  const root = join(s.dir, 'assets');
  const walk = (dir: string, rel: string) => {
    let names: Dirent[];
    try {
      names = readdirSyncSafe(dir);
    } catch {
      return;
    }
    for (const d of names) {
      if (d.name.startsWith('.')) continue;
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(join(dir, d.name), r);
      else if (d.isFile()) link(ctx, `styles/${s.id}/assets${r}`, join(dir, d.name));
    }
  };
  walk(root, '');
}

function readdirSyncSafe(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name));
}
