// First-run setup in the engine host (app spec "First-run setup"; plan phase 09): `setup.status`,
// `setup.install`, `setup.updateYtDlp` and the `setup.progress` events. It keeps the engine's tool
// paths in step with what setup finds (the engine reads them at use time), re-syncs a Python env
// built from an older `uv.lock` on launch (D-12), and runs the "New version" check (D-02).
import { join } from 'node:path';
import type { DoctorReport } from '@vox/engine';
import { isAbortError, SetupError } from './setup/errors.ts';
import { linkToolBins } from './setup/bins.ts';
import { loadManifest, type Manifest } from './setup/manifest.ts';
import { PY_ENV_ID } from './setup/pyenv.ts';
import {
  getSetupStatus,
  installAll,
  repairComponent,
  type Delegate,
  type InstallAllResult,
  type SetupContext,
  type SetupStatus,
} from './setup/setup.ts';
import type { SetupProgressEvent } from './setup/types.ts';
import { checkForUpdate, type UpdateResult } from './setup/update.ts';
import { updateYtDlp } from './setup/ytdlp.ts';

export interface AppSetupOptions {
  toolsDir: string;
  /** The uv project the app ships (`<resources>/py`, or the repo's `py/` in development). */
  pyDir: string;
  /** `<resources>/bin/uv` in a packaged app. */
  bundledUvPath?: string;
  env: NodeJS.ProcessEnv;
  /** The engine's live tool map (`openEngine({ tools })`); updated in place. */
  tools: Record<string, string | undefined>;
  emit: (event: SetupProgressEvent) => void;
  doctor: (opts: { quick?: boolean }) => Promise<DoctorReport>;
  delegates?: Record<string, Delegate>;
  /**
   * Packaged app: the engine always uses `<tools>/py-env` (never a `.venv` inside the app bundle,
   * S31), even before setup created it; in development the repo's own uv env stays the fallback.
   */
  packaged: boolean;
  /** `owner/name` for the update check; undefined or '' turns it off. */
  updateRepo?: string;
  updateApiBase?: string;
  currentVersion: string;
  /** Tests only. */
  manifest?: Manifest;
  fetchImpl?: typeof fetch;
  allowLoopbackHttp?: boolean;
  fallbackDirs?: string[];
}

export interface AppSetupStatus extends SetupStatus {
  /** Engine doctor, run when every component is ready (setup ends with it). */
  doctor?: DoctorReport;
  /**
   * The doctor is running for the current component state (a full run takes up to a minute: it
   * imports the Python stack); a `setup.progress` event with component `doctor`, phase `done`
   * follows, and the next status carries the report.
   */
  doctorRunning: boolean;
  /** Every component ready and the doctor has no error: the green "Ready". */
  done: boolean;
  /** Component id → what it is doing now (an install is running). */
  busy: string[];
  update: UpdateResult | { status: 'pending' };
}

/** Error data for IPC (`code`, `message`, `hint`), so the renderer can show the fix. */
function failure(e: unknown): { code: string; message: string; hint: string } {
  if (e instanceof SetupError)
    return {
      code: `SETUP_${e.code}`,
      message: e.message,
      hint: 'Try again, or repair the component on the setup screen',
    };
  return {
    code: 'SETUP_FAILED',
    message: e instanceof Error ? e.message : String(e),
    hint: 'See the log for details',
  };
}

export class AppSetup {
  private readonly o: AppSetupOptions;
  private readonly abort = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly busy = new Set<string>();
  private update: UpdateResult | { status: 'pending' } = { status: 'pending' };
  /** Doctor report per component-state key; one run per key. */
  private doctorRun: { key: string; report?: DoctorReport; running: Promise<void> } | undefined;
  /** Tool paths found without setup (PATH, Homebrew); used when setup has nothing better. */
  private readonly base: Readonly<Record<string, string | undefined>>;

  constructor(o: AppSetupOptions) {
    this.o = o;
    this.base = { ...o.tools };
  }

  private manifest(): Manifest {
    return this.o.manifest ?? loadManifest();
  }

  private ctx(): SetupContext {
    const o = this.o;
    return {
      toolsDir: o.toolsDir,
      pyDir: o.pyDir,
      signal: this.abort.signal,
      env: o.env,
      manifest: this.manifest(),
      onProgress: (e) => o.emit(e),
      ...(o.bundledUvPath === undefined ? {} : { bundledUvPath: o.bundledUvPath }),
      ...(o.delegates === undefined ? {} : { delegates: o.delegates }),
      ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
      ...(o.allowLoopbackHttp === undefined ? {} : { allowLoopbackHttp: o.allowLoopbackHttp }),
      ...(o.fallbackDirs === undefined ? {} : { fallbackDirs: o.fallbackDirs }),
    };
  }

  /** One setup action at a time (installs, repairs and yt-dlp updates share the tools folder). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Points the engine's tool map at what setup found; a tool that is not ready is removed. */
  private async syncTools(s: SetupStatus): Promise<void> {
    const t = this.o.tools;
    const linked = await linkToolBins(this.o.toolsDir, this.manifest());
    const ready = (id: string) => s.components.find((c) => c.id === id)?.state === 'ready';
    const ff = s.ffmpeg;
    const set = (k: string, v: string | undefined) => {
      const value = v ?? this.base[k];
      if (value === undefined) delete t[k];
      else t[k] = value;
    };
    set('ffmpeg', ff.state === 'ok' ? ff.ffmpegPath : undefined);
    set('ffprobe', ff.state === 'ok' ? ff.ffprobePath : undefined);
    set('deno', linked['deno']);
    set('yt-dlp', linked['yt-dlp']);
    set('uv', s.components.find((c) => c.id === 'uv')?.path);
    t['py'] = this.o.pyDir;
    t['dir'] = this.o.toolsDir;
    if (this.o.packaged || ready(PY_ENV_ID)) t['pyEnv'] = join(this.o.toolsDir, 'py-env');
    else delete t['pyEnv'];
  }

  /** Starts (or reuses) the doctor run for this component state. */
  private doctorFor(s: SetupStatus): NonNullable<AppSetup['doctorRun']> {
    const key = JSON.stringify([
      s.components.map((c) => [c.id, c.state, c.path ?? '', c.version ?? '']),
      s.ffmpeg.ffmpegPath ?? '',
    ]);
    if (this.doctorRun?.key === key) return this.doctorRun;
    const run: NonNullable<AppSetup['doctorRun']> = {
      key,
      running: this.o
        .doctor({})
        .catch((e: unknown): DoctorReport => ({
          ok: false,
          checks: [{ name: 'doctor', level: 'error', detail: String(e) }],
        }))
        .then((report) => {
          run.report = report;
          this.o.emit({ type: 'setup.progress', component: 'doctor', phase: 'done' });
        }),
    };
    this.doctorRun = run;
    return run;
  }

  /** `waitForDoctor` (tests, the CLI) waits for the doctor instead of reporting it as running. */
  async status(o: { waitForDoctor?: boolean } = {}): Promise<AppSetupStatus> {
    const s = await getSetupStatus(this.ctx());
    await this.syncTools(s);
    const run = s.ready ? this.doctorFor(s) : undefined;
    if (run && o.waitForDoctor) await run.running;
    const doctor = run?.report;
    return {
      ...s,
      ...(doctor === undefined ? {} : { doctor }),
      doctorRunning: run !== undefined && doctor === undefined,
      done: s.ready && doctor !== undefined && doctor.ok,
      busy: [...this.busy],
      update: this.update,
    };
  }

  /** `'all'` installs every component that is not ready; an id re-runs that one (Repair). */
  install(component: string): Promise<InstallAllResult> {
    const ids = this.manifest().components.map((c) => c.id);
    if (component !== 'all' && !ids.includes(component))
      return Promise.reject(
        failure(new SetupError('NOT_INSTALLABLE', `unknown component ${component}`)),
      );
    return this.serial(async () => {
      this.busy.add(component);
      try {
        if (component === 'all') return await installAll(this.ctx());
        try {
          await repairComponent(component, this.ctx());
          return { installed: [component], skipped: [], failed: [] };
        } catch (e) {
          if (isAbortError(e)) throw e;
          throw failure(e);
        }
      } finally {
        this.busy.delete(component);
        await this.syncTools(await getSetupStatus(this.ctx())).catch(() => undefined);
      }
    });
  }

  updateYtDlp(): Promise<{ version: string }> {
    return this.serial(async () => {
      const bin = this.o.tools['yt-dlp'];
      if (bin === undefined)
        throw failure(new SetupError('BINARY_MISSING', 'yt-dlp is not installed yet'));
      try {
        return await updateYtDlp(bin, {
          signal: this.abort.signal,
          env: this.o.env,
          onOutput: (line) =>
            this.o.emit({
              type: 'setup.progress',
              component: 'yt-dlp',
              phase: 'install',
              message: line,
            }),
        });
      } catch (e) {
        throw failure(e);
      }
    });
  }

  /**
   * On launch: point the engine at the installed tools, re-sync a stale Python env (an app update
   * that ships a new `uv.lock`, D-12) and check for a newer release. Never throws.
   */
  async onLaunch(): Promise<void> {
    try {
      const s = await getSetupStatus(this.ctx());
      await this.syncTools(s);
      if (s.components.find((c) => c.id === PY_ENV_ID)?.state === 'stale')
        await this.install(PY_ENV_ID).catch(() => undefined);
    } catch {
      // the setup screen shows the state; launch must not fail on it
    }
    this.update = await checkForUpdate({
      repo: this.o.updateRepo,
      ...(this.o.updateApiBase === undefined ? {} : { apiBase: this.o.updateApiBase }),
      currentVersion: this.o.currentVersion,
      signal: this.abort.signal,
      ...(this.o.fetchImpl === undefined ? {} : { fetchImpl: this.o.fetchImpl }),
      ...(this.o.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: this.o.allowLoopbackHttp }),
    });
  }

  /** Stops running installs (host shutdown). */
  stop(): void {
    this.abort.abort();
  }
}
