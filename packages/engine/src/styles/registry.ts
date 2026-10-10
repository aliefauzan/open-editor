// Style registry over `stylesDirs` (styles spec "Style registry", engine "Library API").
// - Search order: dirs in order; an id may exist in one dir only. A later copy is rejected
//   (`STYLE_DUPLICATE`) and the earlier one stays, so installing a user style never changes projects.
// - `extends`: every chain ends in `base`, at most MAX_EXTENDS_DEPTH hops, no cycles. A child overrides
//   tokens (colours, fonts, motion and texture by key), pacing, imagery, sfx (by name) and guide
//   sections (by `## ` heading); captions and overlays are inherited when the child leaves them out.
// - Template identity is `<declaringStyleId>/<name>`. Hook trust (S8) comes from the declaring style.
// Loading is synchronous and eager: problems are collected, never thrown at load; `get` throws them.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { VoxError } from '../errors.pending.ts';
import {
  parseCaptionPreset,
  parseStyle,
  parseStyleFile,
  parseTemplate,
  type CaptionPreset,
  type Style,
  type StyleFile,
  type Template,
} from './schema.ts';

export const MAX_EXTENDS_DEPTH = 4;
const ROOT_STYLE = 'base';
const PREVIEW_EXT = /\.(?:jpe?g|png|gif|webp)$/i;

export type TemplateDef = Template & {
  /** `<styleId>/<name>` of the declaring style. */
  id: string;
  styleId: string;
  dir: string;
  htmlPath: string;
  /** `build.mjs` when present; runs only when `trusted` (compile, S8). */
  hookPath?: string;
  /** Trust of the declaring style, not of the style that uses the template (S8). */
  trusted: boolean;
  fixtures: string[];
};

export type CaptionPresetDef = CaptionPreset & { id: string; styleId: string; htmlPath: string };

export interface OverlayDef {
  name: string;
  default: boolean;
  styleId: string;
  htmlPath: string;
}

export interface ResolvedStyle {
  id: string;
  dir: string;
  /** `[id, parent, …, 'base']`. */
  chain: string[];
  /** The merged, complete style. Own fields (id, status, trusted, templates…) are never inherited. */
  style: Style;
  /** Merged `guide.md`. */
  guide: string;
  /** Every template the style can use: its own and its ancestors', by full id. */
  templates: Record<string, TemplateDef>;
  /** The presets listed in `style.captions.presets`, in that order. */
  captionPresets: Record<string, CaptionPresetDef>;
  overlays: OverlayDef[];
  /** Absolute paths of the files the merged tokens and sfx name, each in its declaring style. */
  files: {
    fonts: { display: string; body: string; caption: string };
    texture?: { paper?: string };
    sfx: Record<string, string>;
  };
  previews: string[];
}

export interface StyleSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  status: Style['status'];
  trusted: boolean;
  source: Style['source'];
  extends?: string;
  dir: string;
  previews: string[];
}

export interface StyleProblem {
  /** Folder name (the style id when the file is valid). */
  id: string;
  dir: string;
  error: VoxError;
}

export interface StyleRegistry {
  readonly stylesDirs: readonly string[];
  /** Installed valid styles, sorted by id. */
  list(): StyleSummary[];
  /** Throws `STYLE_NOT_FOUND`, or the style's `STYLE_INVALID`. */
  get(id: string): ResolvedStyle;
  /** A template of any valid installed style by full id (`<styleId>/<name>`). */
  template(id: string): TemplateDef | undefined;
  /** Rejected style folders (invalid or duplicate), in search order. */
  problems(): StyleProblem[];
}

interface Candidate {
  id: string;
  dir: string;
  dirIndex: number;
  realDir: string;
  file?: StyleFile;
  error?: VoxError;
}

type Reason =
  | 'json'
  | 'schema'
  | 'id-mismatch'
  | 'extends-missing'
  | 'extends-cycle'
  | 'extends-depth'
  | 'extends-root'
  | 'parent-invalid'
  | 'file-missing'
  | 'path'
  | 'template-name'
  | 'template-kind'
  | 'sfx-unknown'
  | 'preset-unknown'
  | 'preset-name';

function invalid(
  style: string,
  reason: Reason,
  message: string,
  details: Record<string, unknown> = {},
  cause?: unknown,
): VoxError {
  return new VoxError(
    'STYLE_INVALID',
    `Style ${style}: ${message}`,
    'Fix the style folder to match the style format (styles spec "Part A"), or remove it',
    { details: { style, reason, ...details }, ...(cause === undefined ? {} : { cause }) },
  );
}

/** Re-tag a schema/JSON error from a file with the style id. */
function asStyleError(style: string, e: unknown): VoxError {
  if (e instanceof VoxError && e.code === 'STYLE_INVALID') {
    if (e.details?.['style'] !== undefined) return e;
    return new VoxError(e.code, `Style ${style}: ${e.message}`, e.hint, {
      details: { style, ...e.details },
    });
  }
  throw e;
}

/** Read a style file as text (containment checked first). */
function readStyleText(c: Candidate, rel: string): string {
  const real = styleFile(c, rel);
  try {
    return readFileSync(real, 'utf8');
  } catch {
    throw invalid(c.id, 'file-missing', `cannot read ${rel}`, { file: join(c.dir, rel) });
  }
}

function readJsonFile(c: Candidate, rel: string): unknown {
  const file = join(c.dir, rel);
  const text = readStyleText(c, rel);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // No file text in the message: it may be anything.
    throw invalid(c.id, 'json', `${file} is not valid JSON`, { file });
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Something exists at `p` (a dangling symlink counts, so it fails loudly instead of being skipped). */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real path of an existing file inside the style folder (path rule). The resolved path is returned,
 * so later reads do not follow a symlink again.
 */
function styleFile(c: Candidate, rel: string): string {
  const file = join(c.dir, rel);
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    throw invalid(c.id, 'file-missing', `${rel} does not exist`, { file });
  }
  const r = relative(c.realDir, real);
  if (r === '' || r.startsWith(`..${sep}`) || r === '..' || r.startsWith(sep)) {
    throw invalid(c.id, 'path', `${rel} points outside the style folder`, { file });
  }
  if (!statSync(real).isFile())
    throw invalid(c.id, 'file-missing', `${rel} is not a file`, { file });
  return real;
}

/** Files in a style subfolder matching `re`, each containment-checked. */
function listFiles(c: Candidate, relDir: string, re: RegExp): string[] {
  if (!isDir(join(c.dir, relDir))) return [];
  return readdirSync(join(c.dir, relDir))
    .filter((f) => re.test(f) && !f.startsWith('.'))
    .sort()
    .map((f) => styleFile(c, `${relDir}/${f}`));
}

// ---- guide sections ----

interface Section {
  heading: string; // '' = text before the first `## ` heading
  text: string;
}

function splitGuide(text: string): Section[] {
  const out: Section[] = [{ heading: '', text: '' }];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^## +(.+?)\s*$/.exec(line);
    if (m) out.push({ heading: m[1]!, text: `${line}\n` });
    else out[out.length - 1]!.text += `${line}\n`;
  }
  return out.map((s) => ({ heading: s.heading, text: s.text.replace(/\n+$/, '\n') }));
}

function mergeGuide(parent: string, child: string): string {
  const sections = splitGuide(parent);
  for (const s of splitGuide(child)) {
    if (s.heading === '' && s.text.trim() === '') continue;
    const i = sections.findIndex((p) => p.heading === s.heading);
    if (i >= 0) sections[i] = s;
    else sections.push(s);
  }
  return sections
    .filter((s) => s.text.trim() !== '')
    .map((s) => s.text)
    .join('\n');
}

// ---- merge ----

function mergeStyle(parent: Style | undefined, f: StyleFile): unknown {
  if (!parent) return f;
  const t = f.tokens ?? {};
  const texture = { ...parent.tokens.texture, ...t.texture };
  return {
    ...f,
    tokens: {
      colors: { ...parent.tokens.colors, ...t.colors },
      fonts: { ...parent.tokens.fonts, ...t.fonts },
      ...(Object.keys(texture).length ? { texture } : {}),
      motion: { ...parent.tokens.motion, ...t.motion },
    },
    captions: f.captions ?? parent.captions,
    overlays: f.overlays ?? parent.overlays,
    pacing: { ...parent.pacing, ...f.pacing },
    imagery: { ...parent.imagery, ...f.imagery },
    sfx: { ...parent.sfx, ...f.sfx },
  };
}

interface Resolved {
  ok?: ResolvedStyle;
  error?: VoxError;
  /** Presets declared (loaded) by the chain, by full id. */
  presets?: Map<string, CaptionPresetDef>;
}

export interface LoadStyleRegistryOptions {
  /** Searched in order; the first entry is the built-in styles folder. */
  stylesDirs: readonly string[];
  /**
   * Trust for a style outside the built-in folder (phase 06 `vox style trust` records it). Such a
   * style's own `trusted` field is never believed: a copied folder cannot trust itself (S8). Default:
   * untrusted.
   */
  isTrusted?: (styleId: string, dir: string) => boolean;
}

export function loadStyleRegistry(opts: LoadStyleRegistryOptions): StyleRegistry {
  const stylesDirs = [...opts.stylesDirs];
  const candidates = new Map<string, Candidate>();
  const problems: StyleProblem[] = [];

  // 1. Scan in search order.
  const dupIndex = new Map<StyleProblem, number>();
  for (const [dirIndex, root] of stylesDirs.entries()) {
    if (!isDir(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (name.startsWith('.') || !isDir(dir) || !present(join(dir, 'style.json'))) continue;
      const first = candidates.get(name);
      if (first) {
        const dup: StyleProblem = {
          id: name,
          dir,
          error: new VoxError(
            'STYLE_DUPLICATE',
            `Style id ${name} is already installed at ${first.dir}; ${dir} is ignored`,
            'Rename the style folder and its id; a user style may not reuse an installed id',
            { details: { style: name, dirs: [first.dir, dir] } },
          ),
        };
        problems.push(dup);
        dupIndex.set(dup, dirIndex);
        continue;
      }
      const c: Candidate = { id: name, dir, dirIndex, realDir: realpathSync(dir) };
      try {
        const file = parseStyleFile(readJsonFile(c, 'style.json'), join(dir, 'style.json'));
        if (file.id !== name) {
          throw invalid(name, 'id-mismatch', `id ${file.id} differs from its folder name`, {
            file: join(dir, 'style.json'),
          });
        }
        c.file = file;
      } catch (e) {
        c.error = asStyleError(name, e);
      }
      candidates.set(name, c);
    }
  }

  // 2. Resolve every candidate (memoised; parents first through recursion).
  const memo = new Map<string, Resolved>();

  function chainOf(id: string): string[] {
    const chain = [id];
    for (;;) {
      const cur = chain[chain.length - 1]!;
      const c = candidates.get(cur)!;
      const parent = c.file?.extends;
      if (parent === undefined) break;
      if (chain.includes(parent)) {
        throw invalid(
          id,
          'extends-cycle',
          `extends chain has a cycle (${[...chain, parent].join(' -> ')})`,
          {
            chain: [...chain, parent],
          },
        );
      }
      const p = candidates.get(parent);
      if (!p) {
        throw invalid(id, 'extends-missing', `${cur} extends ${parent}, which is not installed`, {
          parent,
        });
      }
      if (chain.length > MAX_EXTENDS_DEPTH) {
        throw invalid(id, 'extends-depth', `extends chain is deeper than ${MAX_EXTENDS_DEPTH}`, {
          chain: [...chain, parent],
        });
      }
      chain.push(parent);
      if (!p.file) break; // the parent's own error is reported below as parent-invalid
    }
    const root = chain[chain.length - 1]!;
    const rootFile = candidates.get(root)!.file;
    if (rootFile && root !== ROOT_STYLE) {
      throw invalid(id, 'extends-root', `extends chain ends in ${root}, not ${ROOT_STYLE}`, {
        chain,
      });
    }
    if (id === ROOT_STYLE && chain.length > 1) {
      throw invalid(
        id,
        'extends-root',
        `${ROOT_STYLE} is the root style and cannot extend another`,
        {
          chain,
        },
      );
    }
    return chain;
  }

  function resolve(id: string): Resolved {
    const hit = memo.get(id);
    if (hit) return hit;
    let r: Resolved;
    try {
      r = build(id);
    } catch (e) {
      r = { error: e instanceof VoxError ? e : invalid(id, 'schema', String(e)) };
    }
    memo.set(id, r);
    return r;
  }

  function build(id: string): Resolved {
    const c = candidates.get(id)!;
    if (c.error) throw c.error;
    const f = c.file!;
    const chain = chainOf(id);
    let parent: Resolved | undefined;
    if (f.extends !== undefined) {
      parent = resolve(f.extends);
      if (parent.error) {
        throw invalid(
          id,
          'parent-invalid',
          `parent style ${f.extends} is invalid`,
          { parent: f.extends },
          parent.error,
        );
      }
    }
    const p = parent?.ok;
    let style: Style;
    try {
      const trusted = c.dirIndex === 0 ? f.trusted : (opts.isTrusted?.(id, c.dir) ?? false);
      style = parseStyle(
        { ...(mergeStyle(p?.style, f) as object), trusted },
        join(c.dir, 'style.json'),
      );
    } catch (e) {
      throw asStyleError(id, e);
    }

    // Files named by the merged tokens and sfx, each resolved in its declaring style.
    const own = f.tokens ?? {};
    const fonts = { ...p?.files.fonts };
    for (const role of ['display', 'body', 'caption'] as const) {
      const font = own.fonts?.[role];
      if (font) fonts[role] = styleFile(c, font.file);
    }
    const texture = { ...p?.files.texture };
    if (own.texture?.paper !== undefined) texture.paper = styleFile(c, own.texture.paper);
    const sfx: Record<string, string> = { ...p?.files.sfx };
    for (const [name, entry] of Object.entries(f.sfx ?? {})) sfx[name] = styleFile(c, entry.path);

    // Own templates.
    const templates: Record<string, TemplateDef> = { ...p?.templates };
    const listed = [
      ...style.templates.map((n) => [n, 'scene'] as const),
      ...style.transitions.map((n) => [n, 'transition'] as const),
    ];
    for (const [name, kind] of listed) {
      const dir = join(c.dir, 'templates', name);
      const rel = `templates/${name}`;
      const file = join(dir, 'template.json');
      let t: Template;
      try {
        t = parseTemplate(readJsonFile(c, `${rel}/template.json`), file);
      } catch (e) {
        throw asStyleError(id, e);
      }
      if (t.name !== name) {
        throw invalid(id, 'template-name', `template ${file} is named ${t.name}, not ${name}`, {
          file,
        });
      }
      if (t.kind !== kind) {
        throw invalid(id, 'template-kind', `template ${name} is a ${t.kind}, listed as a ${kind}`, {
          file,
        });
      }
      for (const cue of t.sfxCues ?? []) {
        if (!Object.hasOwn(style.sfx, cue.sfx)) {
          throw invalid(
            id,
            'sfx-unknown',
            `template ${name} cue ${cue.name} names unknown sfx ${cue.sfx}`,
            {
              file,
              sfx: cue.sfx,
            },
          );
        }
      }
      const htmlPath = styleFile(c, `${rel}/template.html`);
      const hook = join(dir, 'build.mjs');
      templates[`${id}/${name}`] = {
        ...t,
        id: `${id}/${name}`,
        styleId: id,
        dir,
        htmlPath,
        ...(present(hook) ? { hookPath: styleFile(c, `${rel}/build.mjs`) } : {}),
        trusted: style.trusted,
        fixtures: listFiles(c, `${rel}/fixtures`, /\.json$/),
      };
    }

    // Caption presets: own ones load from captions/<preset>.{json,html}; others come from the chain.
    const presets = new Map(parent?.presets);
    const captionPresets: Record<string, CaptionPresetDef> = {};
    for (const presetId of style.captions.presets) {
      const [styleId, name] = presetId.split('/') as [string, string];
      if (styleId === id && !presets.has(presetId)) {
        const file = join(c.dir, `captions/${name}.json`);
        let preset: CaptionPreset;
        try {
          preset = parseCaptionPreset(readJsonFile(c, `captions/${name}.json`), file);
        } catch (e) {
          throw asStyleError(id, e);
        }
        if (preset.name !== name) {
          throw invalid(
            id,
            'preset-name',
            `caption preset ${file} is named ${preset.name}, not ${name}`,
            {
              file,
            },
          );
        }
        presets.set(presetId, {
          ...preset,
          id: presetId,
          styleId: id,
          htmlPath: styleFile(c, `captions/${name}.html`),
        });
      }
      const def = presets.get(presetId);
      if (!def) {
        throw invalid(
          id,
          'preset-unknown',
          `caption preset ${presetId} is not declared in the extends chain`,
          {
            preset: presetId,
          },
        );
      }
      captionPresets[presetId] = def;
    }

    // Overlays: inherited as resolved, or looked up nearest-first along the chain.
    let overlays: OverlayDef[];
    if (f.overlays === undefined && p) {
      overlays = p.overlays;
    } else {
      overlays = style.overlays.map((o) => {
        for (const sid of chain) {
          const sc = candidates.get(sid)!;
          if (present(join(sc.dir, 'overlays', `${o.name}.html`))) {
            return { ...o, styleId: sid, htmlPath: styleFile(sc, `overlays/${o.name}.html`) };
          }
        }
        throw invalid(
          id,
          'file-missing',
          `overlay ${o.name} has no overlays/${o.name}.html in the chain`,
          {
            file: join(c.dir, 'overlays', `${o.name}.html`),
          },
        );
      });
    }

    const guideFile = join(c.dir, 'guide.md');
    const ownGuide = present(guideFile) ? readStyleText(c, 'guide.md') : '';
    const fontsDone = fonts as ResolvedStyle['files']['fonts'];
    return {
      presets,
      ok: {
        id,
        dir: c.dir,
        chain,
        style,
        guide: p ? mergeGuide(p.guide, ownGuide) : mergeGuide('', ownGuide),
        templates: Object.fromEntries(
          Object.entries(templates).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
        captionPresets,
        overlays,
        files: { fonts: fontsDone, ...(Object.keys(texture).length ? { texture } : {}), sfx },
        previews: listFiles(c, 'previews', PREVIEW_EXT),
      },
    };
  }

  const resolved = new Map<string, ResolvedStyle>();
  const byTemplate = new Map<string, TemplateDef>();
  for (const [id, c] of candidates) {
    const r = resolve(id);
    if (r.ok) {
      resolved.set(id, r.ok);
      for (const t of Object.values(r.ok.templates)) if (t.styleId === id) byTemplate.set(t.id, t);
    } else {
      problems.push({ id, dir: c.dir, error: r.error! });
    }
  }
  const indexOf = (p: StyleProblem) => dupIndex.get(p) ?? candidates.get(p.id)?.dirIndex ?? 0;
  problems.sort((a, b) => indexOf(a) - indexOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    stylesDirs,
    list() {
      return [...resolved.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((r) => ({
          id: r.id,
          name: r.style.name,
          description: r.style.description,
          version: r.style.version,
          status: r.style.status,
          trusted: r.style.trusted,
          source: r.style.source,
          ...(r.style.extends === undefined ? {} : { extends: r.style.extends }),
          dir: r.dir,
          previews: r.previews,
        }));
    },
    get(id) {
      const r = resolved.get(id);
      if (r) return r;
      const c = candidates.get(id);
      if (c) throw memo.get(id)!.error!;
      throw new VoxError(
        'STYLE_NOT_FOUND',
        `Style ${id} is not installed`,
        'Check the style id; `vox paths` lists the styles folders',
        {
          details: { style: id, stylesDirs },
        },
      );
    },
    template(id) {
      return byTemplate.get(id);
    },
    problems() {
      return [...problems];
    },
  };
}
