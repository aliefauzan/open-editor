// Path rule and projects-folder resolution (engine spec "Project folder", plan R4 S1, D-10).
// Published as `@vox/engine/paths` for the desktop main process: node built-ins and errors.ts only.

import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { VoxError } from './errors.ts';

const PROJECT_ID = /^p_[a-z0-9]+$/;
const STILL_ENCODED = /%[0-9a-fA-F]{2}/;

function decodeOnce(rel: string): string | undefined {
  try {
    return decodeURIComponent(rel);
  } catch {
    return undefined;
  }
}

/** Lexical half of the path rule: decode once; reject NUL, absolute, `..`, backslash, double encoding. */
export function checkRelativePath(rel: string): boolean {
  if (rel.length === 0) return false;
  const decoded = decodeOnce(rel);
  if (decoded === undefined || decoded.length === 0) return false;
  if (decoded.includes('\0') || decoded.includes('\\')) return false;
  if (STILL_ENCODED.test(decoded)) return false; // double-encoded input
  if (isAbsolute(decoded)) return false;
  return !decoded.split('/').some((seg) => seg === '..');
}

function invalid(rel: string, why: string): VoxError {
  return new VoxError(
    'PATH_INVALID',
    `Path ${JSON.stringify(rel)} is not allowed: ${why}`,
    'Use a relative path inside the project folder',
  );
}

export interface ResolveOptions {
  /** false: the file may not exist yet; its parent folder must (default true). */
  mustExist?: boolean;
}

/**
 * Full path rule: decode once; reject NUL, absolute paths and any `..`; resolve with `realpath`;
 * accept only under `realpath(projectDir) + sep`.
 */
export async function resolveProjectPath(
  projectDir: string,
  rel: string,
  opts: ResolveOptions = {},
): Promise<string> {
  if (!checkRelativePath(rel)) throw invalid(rel, 'NUL, absolute, `..` or bad encoding');
  const decoded = decodeOnce(rel) as string;
  const base = await realpath(projectDir).catch(() => {
    throw invalid(rel, 'project folder missing');
  });
  const target = join(base, decoded);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    if (opts.mustExist !== false) throw invalid(rel, 'file does not exist');
    const parent = await realpath(dirname(target)).catch(() => {
      throw invalid(rel, 'parent folder does not exist');
    });
    real = join(parent, basename(target));
  }
  if (!real.startsWith(base + sep)) throw invalid(rel, 'outside the project folder');
  return real;
}

/** `<projectsDir>/<projectId>`; the id must look like a project id. */
export function projectDirFor(projectsDir: string, projectId: string): string {
  if (!PROJECT_ID.test(projectId)) {
    throw new VoxError(
      'PROJECT_NOT_FOUND',
      `${JSON.stringify(projectId)} is not a project id`,
      'Use an id from `vox` project listings (p_…)',
    );
  }
  return join(projectsDir, projectId);
}

export function isProjectId(id: string): boolean {
  return PROJECT_ID.test(id);
}

export interface ProjectsDirInput {
  flag?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /** `projectsDir` from ~/.vox/config.json (wired in phase 04). */
  config?: string | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
}

export type ProjectsDirSource = 'flag' | 'env' | 'config' | 'default';

/** `--projects-dir` > `VOX_PROJECTS_DIR` > config `projectsDir` > `~/Movies/Vox Studio`. */
export function resolveProjectsDir(input: ProjectsDirInput): {
  dir: string;
  source: ProjectsDirSource;
} {
  const cwd = input.cwd ?? process.cwd();
  const pick = (v: string | undefined): string | undefined =>
    v && v.length > 0 ? resolve(cwd, v) : undefined;
  const flag = pick(input.flag);
  if (flag) return { dir: flag, source: 'flag' };
  const env = pick(input.env['VOX_PROJECTS_DIR']);
  if (env) return { dir: env, source: 'env' };
  const config = pick(input.config);
  if (config) return { dir: config, source: 'config' };
  return { dir: join(input.home ?? homedir(), 'Movies', 'Vox Studio'), source: 'default' };
}

/** Create the projects folder (mode 0700) if missing. */
export async function ensureProjectsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
