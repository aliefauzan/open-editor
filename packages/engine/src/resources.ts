// Files the engine ships with (places index, the vox runtime scripts, the pinned HyperFrames + GSAP
// packages, the uv project). In the repo they resolve next to the sources; a packaged app or the
// bundled `vox` CLI sets them once at start to the app's Resources folders (plan R1 "Packaged app",
// phase 09). Paths are read at use time, so setting them before the first use is enough.
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface ResourceDirs {
  /** Folder with `places.json` (repo: `packages/engine/data`; packaged: `<resources>/engine-data`). */
  data?: string;
  /** Folder with `vox-runtime.js` and `vox-preview.js` (repo: `src/compile/runtime`). */
  runtime?: string;
  /** Folder whose `node_modules` holds `hyperframes` and `gsap` (packaged: `<resources>/hyperframes`). */
  modules?: string;
  /** The uv project (`py/` with `uv.lock`). */
  py?: string;
}

let current: ResourceDirs = {};

/** Replaces the resource folders (unset keys fall back to the repo layout). */
export function setResourceDirs(dirs: ResourceDirs): void {
  current = { ...dirs };
}

export function resourceDirs(): Readonly<ResourceDirs> {
  return current;
}

export function dataDir(): string {
  // paths, not URLs: jsdom test environments rewrite import.meta.url (the renderer tests run the
  // engine there)
  return current.data ?? join(import.meta.dirname, '..', 'data');
}

export function runtimeDir(): string {
  return current.runtime ?? join(import.meta.dirname, 'compile', 'runtime');
}

export function pyProjectDir(): string {
  return current.py ?? join(import.meta.dirname, '..', '..', '..', 'py');
}

/** `require` that resolves the pinned node packages (HyperFrames, GSAP). */
export function moduleRequire(): NodeJS.Require {
  return createRequire(
    current.modules === undefined ? import.meta.url : join(current.modules, 'resolve.js'),
  );
}
