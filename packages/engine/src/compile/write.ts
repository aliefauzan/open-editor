// `writeBuild`: a BuildResult on disk under `build/<sequenceId>/` (replaced each time). Linked files
// are hard-linked, or copied across devices; vendored files come from the pinned packages.
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VoxError } from '../errors.ts';
import { moduleRequire, runtimeDir } from '../resources.ts';
import type { BuildResult } from './compile.ts';

/** Absolute paths of the vendored files: GSAP and the HyperFrames runtime from the pinned packages. */
export function vendorSources(): Record<string, string> {
  const req = moduleRequire();
  const RUNTIME = runtimeDir();
  const pkgDir = (name: string) => dirname(req.resolve(`${name}/package.json`));
  return {
    'gsap.min.js': join(pkgDir('gsap'), 'dist', 'gsap.min.js'),
    'hyperframe.runtime.iife.js': join(pkgDir('hyperframes'), 'dist', 'hyperframe.runtime.iife.js'),
    'vox-runtime.js': join(RUNTIME, 'vox-runtime.js'),
    'vox-preview.js': join(RUNTIME, 'vox-preview.js'),
  };
}

/** `<projectDir>/build/<sequenceId>`. */
export function buildDirFor(projectDir: string, sequenceId: string): string {
  return join(projectDir, 'build', sequenceId);
}

/** Writes `build` to `dir` (the folder is replaced). Returns `dir`. */
export function writeBuildTo(build: BuildResult, dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  const put = (rel: string) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    return p;
  };
  for (const [rel, content] of [...build.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    writeFileSync(put(rel), content);
  }
  for (const [rel, from] of [...build.links].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!existsSync(from)) {
      throw new VoxError(
        'MEDIA_MISSING',
        `${rel}: source file is missing`,
        'Re-import the media (its file was moved or deleted)',
        { details: { path: rel } },
      );
    }
    const p = put(rel);
    try {
      linkSync(from, p);
    } catch {
      copyFileSync(from, p);
    }
  }
  const vendor = vendorSources();
  for (const name of build.vendor) {
    const from = vendor[name];
    if (!from) throw new Error(`no vendor source for ${name}`);
    copyFileSync(from, put(`vendor/${name}`));
  }
  return dir;
}
