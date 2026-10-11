// Style management (styles spec "Style registry", phase 06): scaffold a user style, record trust for
// it outside its folder (S8, D-23), accept a draft, remove a user style. The first `stylesDirs`
// entry is the built-in folder (never changed here); new styles go to the last entry
// (`~/.vox/styles`).
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { VoxError } from '../errors.ts';
import type { StyleRegistry } from './registry.ts';
import { StyleFileSchema } from './schema.ts';

const STYLE_ID = /^[a-z0-9-]+$/;
const CODE_FILE = /\.(?:mjs|cjs|js)$/;

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Folder names in every styles directory (valid or not), with the directory index. */
function installed(stylesDirs: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [i, root] of stylesDirs.entries()) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || out.has(name)) continue;
      if (existsSync(join(root, name, 'style.json'))) out.set(name, i);
    }
  }
  return out;
}

function notFound(id: string): VoxError {
  return new VoxError(
    'STYLE_NOT_FOUND',
    `Style ${id} is not installed`,
    'Check the id; `vox paths` prints the styles folders',
    {
      details: { style: id },
    },
  );
}

function builtIn(id: string, what: string): VoxError {
  return new VoxError(
    'VALIDATION',
    `${id} is a built-in style; it cannot be ${what}`,
    'Create your own style with `vox style new <id> --extends <style>`',
    { details: { style: id } },
  );
}

/** Folder of an installed user style; built-in or missing styles throw. */
function userStyleDir(stylesDirs: readonly string[], id: string, what: string): string {
  const where = installed(stylesDirs).get(id);
  if (where === undefined) throw notFound(id);
  if (where === 0) throw builtIn(id, what);
  return join(stylesDirs[where]!, id);
}

export interface NewStyleOptions {
  stylesDirs: readonly string[];
  registry: StyleRegistry;
  id: string;
  /** Parent style; default `base`. */
  extends?: string;
  name?: string;
}

/**
 * Scaffolds `<user styles>/<id>/`: a partial child `style.json` (draft, untrusted, no own templates),
 * `guide.md`, and empty `templates/`. Rejects an id that is not `[a-z0-9-]+`, a built-in id and an id
 * installed in any styles folder (`STYLE_DUPLICATE`); the parent must load.
 */
export function newStyle(o: NewStyleOptions): { id: string; dir: string } {
  const id = o.id;
  if (typeof id !== 'string' || !STYLE_ID.test(id) || id.length > 64) {
    throw new VoxError(
      'VALIDATION',
      `${JSON.stringify(id)} is not a style id`,
      'Use lower-case letters, digits and dashes, e.g. my-style',
      { details: { style: id } },
    );
  }
  const where = installed(o.stylesDirs).get(id);
  if (where !== undefined) {
    throw new VoxError(
      'STYLE_DUPLICATE',
      where === 0
        ? `${id} is a built-in style id`
        : `Style ${id} is already installed at ${join(o.stylesDirs[where]!, id)}`,
      'Pick another id; a user style may not reuse an installed id',
      { details: { style: id, builtIn: where === 0 } },
    );
  }
  const parent = o.extends ?? 'base';
  o.registry.get(parent); // STYLE_NOT_FOUND / STYLE_INVALID
  const root = o.stylesDirs[o.stylesDirs.length - 1];
  if (root === undefined || o.stylesDirs.length < 2) {
    throw new VoxError('VALIDATION', 'No user styles folder', 'Configure a user styles folder');
  }
  const dir = join(root, id);
  const file = {
    id,
    name: o.name ?? id,
    version: '0.1.0',
    description: `A user style that extends ${parent}.`,
    status: 'draft',
    extends: parent,
    source: { type: 'user' },
    trusted: false,
    templates: [],
    transitions: [],
  };
  StyleFileSchema.parse(file);
  mkdirSync(join(dir, 'templates'), { recursive: true });
  writeJsonAtomic(join(dir, 'style.json'), file);
  writeFileSync(
    join(dir, 'guide.md'),
    `# ${file.name}\n\nHow the agent should edit in this style. Sections here override ${parent}'s.\n`,
  );
  return { id, dir };
}

/** Sets `status: 'active'` in a user style's own `style.json`. */
export function acceptStyle(stylesDirs: readonly string[], id: string): void {
  const dir = userStyleDir(stylesDirs, id, 'accepted');
  const file = join(dir, 'style.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  StyleFileSchema.parse(json);
  if (json['status'] === 'active') return;
  writeJsonAtomic(file, { ...json, status: 'active' });
}

/**
 * Deletes a user style folder. Fails when another installed style extends it (`VALIDATION`), so a
 * child never loses its parent silently.
 */
export function removeStyle(
  stylesDirs: readonly string[],
  registry: StyleRegistry,
  id: string,
): string {
  const dir = userStyleDir(stylesDirs, id, 'removed');
  const children = registry
    .list()
    .filter((s) => s.extends === id)
    .map((s) => s.id);
  if (children.length > 0) {
    throw new VoxError(
      'VALIDATION',
      `Style ${id} is extended by ${children.join(', ')}`,
      'Remove or re-parent those styles first',
      { details: { style: id, children } },
    );
  }
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

// ---- trust (S8) ----

/**
 * SHA-256 over the code files of a style folder (`*.mjs`, `*.cjs`, `*.js`: hooks and their vendored
 * libraries), path-sorted. Editing a hook after `vox style trust` withdraws the trust.
 */
export function styleCodeHash(dir: string): string {
  const base = realpathSync(dir);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && CODE_FILE.test(name)) files.push(p);
    }
  };
  walk(base);
  const h = createHash('sha256');
  for (const f of files) {
    const rel = relative(base, f).split(sep).join('/');
    const body = readFileSync(f);
    h.update(`${rel}\0${body.length}\0`);
    h.update(body);
  }
  return h.digest('hex');
}

interface TrustFile {
  version: 1;
  styles: Record<string, { hash: string; trustedAt: string }>;
}

export interface TrustStore {
  readonly file: string;
  /** `isTrusted` for the style registry: a record for the id whose hash matches the folder now. */
  isTrusted(styleId: string, dir: string): boolean;
  trust(styleId: string, dir: string, now?: Date): void;
  forget(styleId: string): void;
}

/** Trust records in `<voxHome>/trust.json` (outside every style folder, D-23). */
export function openTrustStore(file: string): TrustStore {
  const read = (): TrustFile => {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<TrustFile>;
      if (j && j.version === 1 && j.styles && typeof j.styles === 'object') return j as TrustFile;
    } catch {
      /* missing or broken: nothing trusted */
    }
    return { version: 1, styles: {} };
  };
  return {
    file,
    isTrusted(styleId, dir) {
      const rec = read().styles[styleId];
      if (!rec) return false;
      try {
        return rec.hash === styleCodeHash(dir);
      } catch {
        return false;
      }
    },
    trust(styleId, dir, now = new Date()) {
      const t = read();
      t.styles[styleId] = { hash: styleCodeHash(dir), trustedAt: now.toISOString() };
      writeJsonAtomic(file, t);
    },
    forget(styleId) {
      const t = read();
      if (!(styleId in t.styles)) return;
      delete t.styles[styleId];
      writeJsonAtomic(file, t);
    },
  };
}

/** Trusts an installed user style (the CLI asks for confirmation first). */
export function trustStyle(stylesDirs: readonly string[], store: TrustStore, id: string): string {
  const dir = userStyleDir(stylesDirs, id, 'trusted (built-in styles are always trusted)');
  store.trust(id, dir);
  return dir;
}
