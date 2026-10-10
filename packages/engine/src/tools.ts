// Tool paths (engine spec "Project folder", "Library API"): the app's tools directory first, then
// PATH (Homebrew's prefix for ffmpeg, D-05). Resolution only looks at files; it never runs a tool.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { repoPyProject } from './py.ts';

/** Tool keys of `ToolPaths` (plus `dir`, `py`, `pyEnv`, `models`). */
export const TOOL_NAMES = ['ffmpeg', 'ffprobe', 'yt-dlp', 'deno', 'node', 'uv'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Homebrew prefixes searched for ffmpeg/ffprobe before PATH (D-05). */
const BREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin'];

export interface ResolveToolsInput {
  /** `VOX_TOOLS_DIR` or the default `~/Library/Application Support/Vox Studio/tools`. */
  toolsDir: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The uv project (`py/`); default: the repo's `py/`. */
  pyProject?: string;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** First executable `name` on a PATH string (absolute entries only). */
export function which(name: string, pathVar: string | undefined): string | undefined {
  for (const d of (pathVar ?? '').split(delimiter)) {
    if (!d || !isAbsolute(d)) continue;
    const p = join(d, name);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/**
 * Resolved tool paths. Keys: `dir` (the tools directory, only when it exists), each `TOOL_NAMES`
 * entry (absent when not found), `py` (uv project), `pyEnv` (`<dir>/py-env` when set up, which
 * turns on the bridge's packaged mode) and `models` (`<dir>/models`, where downloaded models go).
 */
export function resolveToolPaths(input: ResolveToolsInput): Record<string, string | undefined> {
  const dir = isDir(input.toolsDir) ? input.toolsDir : undefined;
  const out: Record<string, string | undefined> = {
    models: join(input.toolsDir, 'models'),
    py: input.pyProject ?? repoPyProject(),
  };
  if (dir) out['dir'] = dir;
  if (dir && isDir(join(dir, 'py-env'))) out['pyEnv'] = join(dir, 'py-env');
  for (const name of TOOL_NAMES) {
    const inDir = dir ? join(dir, 'bin', name) : undefined;
    let found = inDir && isExecutable(inDir) ? inDir : undefined;
    if (!found && (name === 'ffmpeg' || name === 'ffprobe')) {
      found = BREW_BINS.map((b) => join(b, name)).find(isExecutable);
    }
    found ??= which(name, input.env['PATH']);
    if (found) out[name] = found;
  }
  return out;
}
