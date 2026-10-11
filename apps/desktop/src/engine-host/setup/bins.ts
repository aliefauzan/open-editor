// `<tools>/bin/<tool>` links. The engine (and the `vox` CLI) look for tools in `<tools>/bin` first
// (engine `resolveToolPaths`); setup installs each pinned tool in its own versioned folder, so a
// relative symlink per ready tool connects the two. Links of tools that are not ready are removed.
import { randomBytes } from 'node:crypto';
import { access, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative } from 'node:path';
import { componentBinaryPath } from './install.ts';
import type { Manifest } from './manifest.ts';

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Updates the links; returns tool id → linked binary for the ready ones. */
export async function linkToolBins(
  toolsDir: string,
  manifest: Manifest,
): Promise<Record<string, string>> {
  const binDir = join(toolsDir, 'bin');
  const out: Record<string, string> = {};
  for (const c of manifest.components) {
    if (c.kind !== 'archive' && c.kind !== 'binary') continue;
    const target = componentBinaryPath(toolsDir, c);
    const link = join(binDir, c.id);
    if (!(await executable(target))) {
      await rm(link, { force: true });
      continue;
    }
    const rel = relative(binDir, target);
    out[c.id] = target;
    if ((await readlink(link).catch(() => undefined)) === rel) continue;
    await mkdir(binDir, { recursive: true });
    // unique per call: two checks in one host (launch + status) may link at the same time
    const tmp = `${link}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    await symlink(rel, tmp);
    await rename(tmp, link);
  }
  return out;
}
