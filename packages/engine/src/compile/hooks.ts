// Template compile hooks (`build.mjs`, styles spec "Compile hook", S8). A hook runs only when the
// style that declares the template is trusted; it gets a seeded, style-confined context.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VoxError } from '../errors.ts';
import { isStyleRelativePath } from '../styles/schema.ts';
import type { TemplateDef } from '../styles/registry.ts';

export interface HookContext {
  /** Deterministic per scene instance (from the item id). */
  seed: number;
  /** A file of the declaring style, style-relative (path rule applied). */
  readAsset(path: string): Buffer;
  /** The URL a template uses for a file the hook returns in `files`. */
  fileUrl(name: string): string;
}

export interface HookResult {
  vars?: Record<string, unknown>;
  files?: Record<string, string | Uint8Array>;
}

type HookFn = (vars: Record<string, unknown>, ctx: HookContext) => HookResult | undefined;

/** 32-bit seed from an instance id (FNV-free: first 4 bytes of sha256). */
export function hookSeed(id: string): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0);
}

const HOOK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function hookUntrusted(def: TemplateDef): VoxError {
  return new VoxError(
    'HOOK_UNTRUSTED',
    `Template ${def.id} has a compile hook, but style ${def.styleId} is not trusted`,
    `Trust the style with \`vox style trust ${def.styleId}\` if you know where it came from, or use another template`,
    { details: { template: def.id, styleId: def.styleId } },
  );
}

/** Reads a style-relative file: relative, no `..`, and inside the style folder after symlinks. */
export function readStyleAsset(styleDir: string, path: string): Buffer {
  const bad = (why: string) =>
    new VoxError(
      'PATH_INVALID',
      `Hook asset ${JSON.stringify(path)} rejected: ${why}`,
      'Use a path inside the style folder',
      {
        details: { path },
      },
    );
  if (typeof path !== 'string' || !isStyleRelativePath(path))
    throw bad('not a style-relative path');
  let base: string;
  let real: string;
  try {
    base = realpathSync(styleDir);
    real = realpathSync(join(base, path));
  } catch {
    throw bad('file does not exist');
  }
  if (!real.startsWith(base + sep)) throw bad('outside the style folder');
  return readFileSync(real);
}

export async function runHook(
  def: TemplateDef,
  styleDir: string,
  vars: Record<string, unknown>,
  instanceId: string,
  fileUrl: (name: string) => string,
): Promise<{ vars: Record<string, unknown>; files: [string, string | Uint8Array][] }> {
  if (!def.hookPath) return { vars, files: [] };
  if (!def.trusted) throw hookUntrusted(def);
  const mod = (await import(pathToFileURL(def.hookPath).href)) as { build?: HookFn };
  if (typeof mod.build !== 'function') {
    throw new VoxError(
      'STYLE_INVALID',
      `${def.id}: build.mjs has no build export`,
      'Export `function build(vars, ctx)` from build.mjs',
      { details: { template: def.id, reason: 'hook' } },
    );
  }
  const ctx: HookContext = {
    seed: hookSeed(instanceId),
    readAsset: (p) => readStyleAsset(styleDir, p),
    fileUrl: (name) => {
      if (!HOOK_FILE.test(name)) {
        throw new VoxError(
          'PATH_INVALID',
          `Hook file name ${JSON.stringify(name)} rejected`,
          'Use a plain file name',
        );
      }
      return fileUrl(name);
    },
  };
  const out = mod.build(structuredClone(vars), ctx) ?? {};
  const files = Object.entries(out.files ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name] of files) ctx.fileUrl(name);
  return { vars: out.vars ?? vars, files };
}
