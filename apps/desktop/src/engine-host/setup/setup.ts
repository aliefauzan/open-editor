// First-run setup orchestration: status of every component, install-all with `setup.progress` events,
// repair of one component. Pure of Electron: the engine host calls these and forwards the events; the
// setup screen (phase 09) renders them.

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { SetupError, isAbortError } from './errors.ts';
import type { SetupErrorCode } from './errors.ts';
import { detectFfmpeg } from './ffmpeg.ts';
import type { FfmpegCheck } from './ffmpeg.ts';
import { componentBinaryPath, componentState, installComponent, sweepStale } from './install.ts';
import { anyLockHeld } from './lock.ts';
import type { InstallContext } from './install.ts';
import { loadManifest } from './manifest.ts';
import type { ArchiveComponent, BinaryComponent, Component, Manifest } from './manifest.ts';
import { checkPyEnv, syncPyEnv, ensurePyEnv, PY_ENV_ID } from './pyenv.ts';
import { disabledStages } from './stages.ts';
import { progress } from './types.ts';
import type { ProgressSink } from './types.ts';

export { disabledStages } from './stages.ts';

/** Installer for a component something else owns (Chrome via the bundled HyperFrames CLI). */
export interface Delegate {
  check(signal: AbortSignal): Promise<boolean>;
  install(signal: AbortSignal, onProgress: ProgressSink | undefined): Promise<void>;
}

export interface SetupContext {
  toolsDir: string;
  signal: AbortSignal;
  /** The bundled py/ project (holds uv.lock). */
  pyDir?: string;
  /** `<resources>/bin/uv`; preferred over a downloaded uv when it exists. */
  bundledUvPath?: string;
  manifest?: Manifest;
  env?: NodeJS.ProcessEnv;
  onProgress?: ProgressSink;
  fetchImpl?: typeof fetch;
  /** Tests only. */
  allowLoopbackHttp?: boolean;
  fallbackDirs?: string[];
  delegates?: Record<string, Delegate>;
}

export type ComponentStateName = 'ready' | 'missing' | 'stale' | 'modified';

export interface ComponentStatus {
  id: string;
  label: string;
  kind: Component['kind'];
  licence: string;
  sizeBytes: number;
  state: ComponentStateName;
  detail?: string;
  path?: string;
  version?: string;
}

export interface SetupStatus {
  components: ComponentStatus[];
  ffmpeg: FfmpegCheck;
  /** stage -> blocking component ids */
  disabledStages: Record<string, string[]>;
  ready: boolean;
}

function manifestOf(ctx: SetupContext): Manifest {
  return ctx.manifest ?? loadManifest();
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The uv to run: the bundled one when present, else the one installed in the tools folder. */
export async function resolveUv(ctx: SetupContext): Promise<string | undefined> {
  if (ctx.bundledUvPath !== undefined && (await isExecutable(ctx.bundledUvPath)))
    return ctx.bundledUvPath;
  const uv = manifestOf(ctx).components.find(
    (c): c is ArchiveComponent => c.id === 'uv' && c.kind === 'archive',
  );
  if (uv === undefined) return undefined;
  const path = componentBinaryPath(ctx.toolsDir, uv);
  return (await isExecutable(path)) ? path : undefined;
}

function installCtx(ctx: SetupContext): InstallContext {
  return {
    toolsDir: ctx.toolsDir,
    signal: ctx.signal,
    ...(ctx.onProgress === undefined ? {} : { onProgress: ctx.onProgress }),
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
    ...(ctx.allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp: ctx.allowLoopbackHttp }),
  };
}

async function statusOf(
  c: Component,
  ctx: SetupContext,
  ffmpeg: FfmpegCheck,
): Promise<ComponentStatus> {
  const base = {
    id: c.id,
    label: c.label,
    kind: c.kind,
    licence: c.licence,
    sizeBytes: c.sizeBytesOnDisk,
  };
  switch (c.kind) {
    case 'archive':
    case 'binary': {
      if (
        c.id === 'uv' &&
        ctx.bundledUvPath !== undefined &&
        (await isExecutable(ctx.bundledUvPath))
      ) {
        return { ...base, state: 'ready', path: ctx.bundledUvPath, detail: 'bundled with the app' };
      }
      const state = await componentState(ctx.toolsDir, c);
      return {
        ...base,
        state,
        version: c.version,
        ...(state === 'ready' ? { path: componentBinaryPath(ctx.toolsDir, c) } : {}),
      };
    }
    case 'uv-sync': {
      if (ctx.pyDir === undefined) {
        return { ...base, state: 'missing', detail: 'the bundled py/ project was not found' };
      }
      const check = await checkPyEnv({
        toolsDir: ctx.toolsDir,
        lockPath: join(ctx.pyDir, 'uv.lock'),
      });
      if (check.state === 'stale') {
        return {
          ...base,
          state: 'stale',
          detail:
            check.stale === 'sources'
              ? 'built from older Python tools than this app ships'
              : 'built from an older uv.lock than this app ships',
        };
      }
      if (check.state === 'missing') {
        const uv = await resolveUv(ctx);
        return {
          ...base,
          state: 'missing',
          ...(uv === undefined ? { detail: 'needs uv first' } : {}),
        };
      }
      return { ...base, state: 'ready' };
    }
    case 'external':
      return {
        ...base,
        state: ffmpeg.state === 'ok' ? 'ready' : 'missing',
        ...(ffmpeg.state === 'ok'
          ? {
              path: ffmpeg.ffmpegPath ?? '',
              ...(ffmpeg.version === undefined ? {} : { version: ffmpeg.version }),
            }
          : {
              detail:
                ffmpeg.state === 'brew-missing'
                  ? 'Homebrew is not installed'
                  : 'ffmpeg is not installed in Homebrew',
            }),
      };
    case 'delegated': {
      const d = ctx.delegates?.[c.id];
      if (d === undefined)
        return { ...base, state: 'missing', detail: 'no installer is wired for this component' };
      return { ...base, state: (await d.check(ctx.signal)) ? 'ready' : 'missing' };
    }
  }
}

/** No network. Cheap enough to call on launch and on "Check again". */
export async function getSetupStatus(ctx: SetupContext): Promise<SetupStatus> {
  const ffmpeg = await detectFfmpeg({
    signal: ctx.signal,
    ...(ctx.env === undefined ? {} : { env: ctx.env }),
    ...(ctx.fallbackDirs === undefined ? {} : { fallbackDirs: ctx.fallbackDirs }),
  });
  const components: ComponentStatus[] = [];
  for (const c of manifestOf(ctx).components) components.push(await statusOf(c, ctx, ffmpeg));
  return {
    components,
    ffmpeg,
    disabledStages: disabledStages(components),
    ready: components.every((c) => c.state === 'ready'),
  };
}

export interface InstallAllResult {
  installed: string[];
  skipped: string[];
  failed: Array<{ id: string; code: SetupErrorCode | 'UNKNOWN'; message: string }>;
}

async function runPySync(ctx: SetupContext, force: boolean): Promise<void> {
  const uvPath = await resolveUv(ctx);
  if (uvPath === undefined) throw new SetupError('NO_UV', 'uv is not available; install uv first');
  if (ctx.pyDir === undefined)
    throw new SetupError('NO_LOCKFILE', 'the bundled py/ project was not found');
  const opts = {
    uvPath,
    pyDir: ctx.pyDir,
    toolsDir: ctx.toolsDir,
    signal: ctx.signal,
    ...(ctx.env === undefined ? {} : { env: ctx.env }),
    ...(ctx.onProgress === undefined ? {} : { onProgress: ctx.onProgress }),
  };
  if (force) await syncPyEnv(opts);
  else await ensurePyEnv(opts);
}

async function installOne(c: Component, ctx: SetupContext, force: boolean): Promise<void> {
  switch (c.kind) {
    case 'archive':
    case 'binary':
      await installComponent(c, installCtx(ctx));
      return;
    case 'uv-sync':
      try {
        await runPySync(ctx, force);
      } catch (e) {
        // syncPyEnv reports its own failures; everything else (no uv, no lockfile) is reported here
        if (!isAbortError(e) && !(e instanceof SetupError && e.code === 'COMMAND_FAILED')) {
          progress(ctx.onProgress, c.id, 'error', {
            message: e instanceof Error ? e.message : String(e),
          });
        }
        throw e;
      }
      return;
    case 'delegated': {
      const d = ctx.delegates?.[c.id];
      if (d === undefined)
        throw new SetupError('NOT_INSTALLABLE', `no installer is wired for ${c.id}`);
      progress(ctx.onProgress, c.id, 'install');
      try {
        await d.install(ctx.signal, ctx.onProgress);
      } catch (e) {
        if (!isAbortError(e)) {
          progress(ctx.onProgress, c.id, 'error', {
            message: e instanceof Error ? e.message : String(e),
          });
        }
        throw e;
      }
      progress(ctx.onProgress, c.id, 'done');
      return;
    }
    case 'external':
      throw new SetupError(
        'NOT_INSTALLABLE',
        `${c.id} is installed by the user with Homebrew (D-05)`,
      );
  }
}

/** Installs every component that is not ready. A failure in one component does not stop the others. */
export async function installAll(ctx: SetupContext): Promise<InstallAllResult> {
  const out: InstallAllResult = { installed: [], skipped: [], failed: [] };
  if (!anyLockHeld()) await sweepStale(ctx.toolsDir);
  const status = await getSetupStatus(ctx);
  const byId = new Map(status.components.map((s) => [s.id, s]));
  for (const c of manifestOf(ctx).components) {
    if (c.kind === 'external') continue;
    ctx.signal.throwIfAborted();
    if (byId.get(c.id)?.state === 'ready') {
      out.skipped.push(c.id);
      continue;
    }
    try {
      await installOne(c, ctx, false);
      out.installed.push(c.id);
    } catch (e) {
      if (isAbortError(e)) throw e;
      const code = e instanceof SetupError ? e.code : 'UNKNOWN';
      const message = e instanceof Error ? e.message : String(e);
      out.failed.push({ id: c.id, code, message });
    }
  }
  return out;
}

/** Re-runs one component from scratch (the setup screen's Repair button). */
export async function repairComponent(id: string, ctx: SetupContext): Promise<void> {
  const c = manifestOf(ctx).components.find((x) => x.id === id);
  if (c === undefined) throw new SetupError('NOT_INSTALLABLE', `unknown component ${id}`);
  if (c.id === 'uv' && ctx.bundledUvPath !== undefined && (await isExecutable(ctx.bundledUvPath))) {
    throw new SetupError(
      'NOT_INSTALLABLE',
      'uv is bundled with the app; reinstall the app to repair it',
    );
  }
  await installOne(c, ctx, true);
}

export type { ArchiveComponent, BinaryComponent };
export { PY_ENV_ID };
