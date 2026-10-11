// Tools folder layout (app spec "First-run setup"). VOX_TOOLS_DIR relocates it; tests always set it.

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function resolveToolsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env['VOX_TOOLS_DIR'];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) throw new Error('VOX_TOOLS_DIR must be an absolute path');
    return override;
  }
  return join(home, 'Library', 'Application Support', 'Vox Studio', 'tools');
}

export interface ToolPaths {
  root: string;
  /** UV_PROJECT_ENVIRONMENT */
  pyEnv: string;
  /** UV_CACHE_DIR */
  uvCache: string;
  /** UV_PYTHON_INSTALL_DIR */
  python: string;
  /** SHA-256 of the bundled uv.lock the env was synced from (D-12) */
  lockHash: string;
  downloads: string;
}

export function toolPaths(toolsDir: string): ToolPaths {
  const pyEnv = join(toolsDir, 'py-env');
  return {
    root: toolsDir,
    pyEnv,
    uvCache: join(toolsDir, 'uv-cache'),
    python: join(toolsDir, 'python'),
    lockHash: join(pyEnv, '.vox-lock-hash'),
    downloads: join(toolsDir, '.downloads'),
  };
}
