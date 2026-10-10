// ffmpeg / ffprobe come from Homebrew only (D-05): never downloaded, never bundled. Setup asks
// `brew --prefix ffmpeg` and, when it is missing, shows the commands for the user to run themselves.
// The command strings below are display text for copy buttons; this module never executes them.

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { runCommand } from './run.ts';

export const HOMEBREW_INSTALL_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
export const FFMPEG_INSTALL_COMMAND = 'brew install ffmpeg';

export type FfmpegState = 'ok' | 'brew-missing' | 'ffmpeg-missing';

export interface FfmpegCheck {
  state: FfmpegState;
  brewPath?: string;
  prefix?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  version?: string;
  /** What to show with copy buttons; empty when ok. */
  commands: string[];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /**
   * Searched after PATH. A Finder-launched app has a minimal PATH, so Homebrew's own directory is tried.
   * Ignored when VOX_NO_BREW_FALLBACK=1 (the clean-install test, D-16).
   */
  fallbackDirs?: string[];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBrew(
  env: NodeJS.ProcessEnv,
  fallbackDirs: string[],
): Promise<string | undefined> {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((d) => isAbsolute(d)); // a relative PATH entry (like ".") is never trusted
  if (env['VOX_NO_BREW_FALLBACK'] !== '1') dirs.push(...fallbackDirs);
  for (const d of dirs) {
    const candidate = join(d, 'brew');
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function detectFfmpeg(opts: DetectOptions): Promise<FfmpegCheck> {
  const env = opts.env ?? process.env;
  const brewPath = await findBrew(env, opts.fallbackDirs ?? ['/opt/homebrew/bin']);
  if (brewPath === undefined) {
    return { state: 'brew-missing', commands: [HOMEBREW_INSTALL_COMMAND, FFMPEG_INSTALL_COMMAND] };
  }
  const missing: FfmpegCheck = {
    state: 'ffmpeg-missing',
    brewPath,
    commands: [FFMPEG_INSTALL_COMMAND],
  };
  const childEnv = { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' };
  let prefix: string;
  try {
    const r = await runCommand(brewPath, ['--prefix', 'ffmpeg'], {
      signal: opts.signal,
      env: childEnv,
      timeoutMs: 30_000,
    });
    prefix = r.stdout.trim().split('\n')[0] ?? '';
    if (r.code !== 0 || !isAbsolute(prefix)) return missing;
  } catch (e) {
    if (opts.signal.aborted) throw e;
    return missing;
  }
  // `brew --prefix <formula>` prints the path even when the formula is not installed, so check the files.
  const ffmpegPath = join(prefix, 'bin', 'ffmpeg');
  const ffprobePath = join(prefix, 'bin', 'ffprobe');
  if (!(await isExecutable(ffmpegPath)) || !(await isExecutable(ffprobePath))) {
    return { ...missing, prefix };
  }
  let version: string | undefined;
  try {
    const v = await runCommand(ffmpegPath, ['-version'], {
      signal: opts.signal,
      timeoutMs: 15_000,
    });
    if (v.code !== 0) return { ...missing, prefix };
    version = /^ffmpeg version (\S+)/m.exec(v.stdout)?.[1];
  } catch (e) {
    if (opts.signal.aborted) throw e;
    return { ...missing, prefix };
  }
  return {
    state: 'ok',
    brewPath,
    prefix,
    ffmpegPath,
    ffprobePath,
    ...(version === undefined ? {} : { version }),
    commands: [],
  };
}
