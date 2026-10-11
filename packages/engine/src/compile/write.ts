// `writeBuild`: a BuildResult on disk under `build/<sequenceId>/` (replaced each time). Linked files
// are hard-linked, or copied across devices; vendored files come from the pinned packages.
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/**
 * Writes `build` to `dir` (the folder is replaced). Returns `dir`. The new build is written to a
 * sibling temp folder and swapped in by two renames, so a preview that has the folder open (the
 * player fetches media lazily) never finds it missing or half written, and a failed write keeps the
 * previous build.
 */
export function writeBuildTo(build: BuildResult, dir: string): string {
  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmp = join(dirname(dir), `.${basename(dir)}.tmp-${tag}`);
  mkdirSync(tmp, { recursive: true });
  try {
    fill(build, tmp);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const old = join(dirname(dir), `.${basename(dir)}.old-${tag}`);
  const had = existsSync(dir);
  if (had) renameSync(dir, old);
  renameSync(tmp, dir);
  if (had) rmSync(old, { recursive: true, force: true });
  return dir;
}

function fill(build: BuildResult, dir: string): void {
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
      // offline media (moved or deleted): the preview still opens without that file; the timeline
      // shows the clip as offline with relink (app spec "Error handling"); exports fail clearly
      if (build.mode === 'preview') continue;
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
}
