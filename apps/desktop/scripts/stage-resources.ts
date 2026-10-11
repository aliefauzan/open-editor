// Stages the packaged app's Resources (plan R1 "Packaged app") into out-resources/, which
// electron-builder copies to `Vox Studio.app/Contents/Resources/` as extraResources:
//   styles/                 built-in styles
//   engine-data/            places.json + NOTICE.md; runtime/ = vox-runtime.js, vox-preview.js
//   hyperframes/node_modules/  the pinned HyperFrames CLI + GSAP with their dependency tree
//   py/                     pyproject.toml, uv.lock, .python-version, vox_py (incl. the vendored
//                           Silero VAD model, D-15); setup syncs it into <tools>/py-env (S31)
//   bin/uv                  pinned uv (setup manifest pin, SHA-256 verified)
//   cli/vox.mjs, cli/vox    the bundled `vox` CLI and its launcher (Electron as Node)
// Used by scripts/build.ts --package; the CLI bundle is written there (vite).
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { installComponent } from '../src/engine-host/setup/install.ts';
import { loadManifest } from '../src/engine-host/setup/manifest.ts';

export const DESKTOP = join(import.meta.dirname, '..');
export const REPO = join(DESKTOP, '..', '..');
export const STAGE = join(DESKTOP, 'out-resources');
const ENGINE = join(REPO, 'packages', 'engine');

const SKIP = new Set([
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '.DS_Store',
  'tests',
]);
const noJunk = (src: string) => !src.split(sep).some((p) => SKIP.has(p));

/** Finds `name` from `fromDir` the way Node does (node_modules folders up to the repo root). */
function findPackage(name: string, fromDir: string): string | undefined {
  for (let d = fromDir; d.startsWith(REPO); d = dirname(d)) {
    const p = join(d, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return realpathSync(p);
    if (d === REPO) break;
  }
  return undefined;
}

/**
 * Lays out every package reachable from `roots` (dependencies, and optionalDependencies that are
 * installed) as a hoisted `node_modules` tree: placed path (relative, `node_modules/...`) → the
 * real package folder. A package goes to the top level unless another version holds that name on
 * its dependent's lookup path; then it is nested under the dependent. pnpm's isolated layout uses
 * symlinks, which a copied bundle cannot.
 */
export function layoutModules(roots: string[], fromDir: string): Map<string, string> {
  const placed = new Map<string, string>(); // placed path -> real dir
  const queue: Array<{ name: string; from: string; at: string; optional: boolean }> = roots.map(
    (name) => ({ name, from: fromDir, at: '', optional: false }),
  );
  const done = new Set<string>(); // placed paths whose dependencies are queued
  while (queue.length > 0) {
    const { name, from, at, optional } = queue.shift()!;
    const real = findPackage(name, from);
    if (real === undefined) {
      if (optional) continue;
      throw new Error(`stage-resources: cannot find ${name} from ${relative(REPO, from)}`);
    }
    // Node lookup from `at`: at/node_modules/name, then each parent node_modules, then the top
    let where: string | undefined;
    let found: string | undefined;
    for (
      let d = at;
      ;
      d = d.includes('node_modules') ? d.slice(0, d.lastIndexOf('/node_modules/')) : ''
    ) {
      const cand = join(d, 'node_modules', name);
      if (placed.has(cand)) {
        found = cand;
        break;
      }
      if (d === '') break;
    }
    if (found !== undefined && placed.get(found) === real) where = found;
    else if (found === undefined) where = join('node_modules', name);
    else where = join(at, 'node_modules', name);
    if (!placed.has(where)) placed.set(where, real);
    if (done.has(where)) continue;
    done.add(where);
    const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const d of Object.keys(pkg.dependencies ?? {}))
      queue.push({ name: d, from: real, at: where, optional: false });
    for (const d of Object.keys(pkg.optionalDependencies ?? {}))
      queue.push({ name: d, from: real, at: where, optional: true });
  }
  return placed;
}

function copyModules(dest: string): number {
  const placed = layoutModules(['hyperframes', 'gsap'], ENGINE);
  for (const [rel, src] of placed) {
    cpSync(src, join(dest, rel), {
      recursive: true,
      dereference: true,
      // a package's own node_modules (pnpm links) are not copied; nested ones are placed above
      filter: (s) => s === src || !relative(src, s).split(sep).includes('node_modules'),
    });
  }
  return placed.size;
}

const LAUNCHER = `#!/bin/sh
# vox: runs the CLI bundled in Vox Studio with the app's Electron as Node (ELECTRON_RUN_AS_NODE).
# Linked from ~/.local/bin/vox or /usr/local/bin/vox by the menu "Install vox Command…".
self=$(/usr/bin/readlink -f "$0") || exit 1
res=$(/usr/bin/dirname "$(/usr/bin/dirname "$self")")
exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$res/../MacOS/Vox Studio" "$res/cli/vox.mjs" "$@"
`;

export async function stageResources(cacheDir = join(DESKTOP, 'cache')): Promise<void> {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  cpSync(join(REPO, 'styles'), join(STAGE, 'styles'), { recursive: true, filter: noJunk });
  const data = join(STAGE, 'engine-data');
  mkdirSync(join(data, 'runtime'), { recursive: true });
  for (const f of ['places.json', 'NOTICE.md']) cpSync(join(ENGINE, 'data', f), join(data, f));
  for (const f of ['vox-runtime.js', 'vox-preview.js'])
    cpSync(join(ENGINE, 'src', 'compile', 'runtime', f), join(data, 'runtime', f));
  const n = copyModules(join(STAGE, 'hyperframes'));
  const py = join(STAGE, 'py');
  mkdirSync(py, { recursive: true });
  for (const f of ['pyproject.toml', 'uv.lock', '.python-version'])
    cpSync(join(REPO, 'py', f), join(py, f));
  cpSync(join(REPO, 'py', 'vox_py'), join(py, 'vox_py'), { recursive: true, filter: noJunk });
  // uv: the setup manifest pin, downloaded once into the build cache and hash-checked (S16)
  const uv = loadManifest().components.find((c) => c.id === 'uv');
  if (uv?.kind !== 'archive') throw new Error('stage-resources: no uv archive in the manifest');
  const got = await installComponent(uv, {
    toolsDir: join(cacheDir, 'tools'),
    signal: AbortSignal.timeout(600_000),
  });
  mkdirSync(join(STAGE, 'bin'), { recursive: true });
  cpSync(got.path, join(STAGE, 'bin', 'uv'));
  chmodSync(join(STAGE, 'bin', 'uv'), 0o755);
  mkdirSync(join(STAGE, 'cli'), { recursive: true });
  writeFileSync(join(STAGE, 'cli', 'vox'), LAUNCHER, { mode: 0o755 });
  process.stdout.write(`staged resources (${n} node packages, uv ${got.version})\n`);
}
