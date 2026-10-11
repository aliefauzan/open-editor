// Engine host: runs in an Electron utilityProcess (app spec "Architecture"). Main sends one message
// with the init data and a MessagePort; the host opens the engine and serves window.vox calls on
// that port. All jobs, file I/O and (later) network and keys live here, never in main.
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  hyperframesBin,
  openEngine,
  readConfig,
  repoPyProject,
  resolveToolPaths,
  setResourceDirs,
  voxHome,
} from '@vox/engine';
import { ensureProjectsDir, resolveProjectsDir } from '@vox/engine/paths';
import { UPDATE_REPO } from '../shared/app-info.ts';
import { AppSetup } from './app-setup.ts';
import { createHandlers, forwardEvents } from './handlers.ts';
import { serve, type PortLike } from './rpc.ts';
import { packagedResourceDirs } from './packaged.ts';
import { PreviewPipeline } from './preview.ts';
import { AppJobs } from './quick.ts';
import { chromeDelegate } from './setup/chrome.ts';

export interface HostInit {
  /** Built-in styles folder (repo `styles/` in dev, `Resources/styles` when packaged). */
  builtinStyles: string;
  /** The app's Resources folder in a packaged app (plan R1 "Packaged app"); absent in dev. */
  resources?: string;
  /** `app.getVersion()`, for the update check. */
  appVersion: string;
}

/** First message on the port: where the engine looks, so main can serve `vox-media://`. */
export interface HostReady {
  ready: { projectsDir: string; stylesDirs: string[]; pid: number };
}

process.parentPort.once('message', (e) => {
  const port = e.ports[0] as unknown as PortLike | undefined;
  if (!port) throw new Error('engine host: no MessagePort from main');
  void start(e.data as HostInit, port);
});

async function start(init: HostInit, port: PortLike): Promise<void> {
  const env = process.env;
  // Tools the engine starts with process.execPath (the pinned HyperFrames CLI) run it as Node: the
  // app's Electron, no system Node (app spec "First-run setup"; RunAsNode fuse stays on, S27).
  env['ELECTRON_RUN_AS_NODE'] = '1';
  const res = init.resources;
  if (res !== undefined) setResourceDirs(packagedResourceDirs(res));
  const pyDir = res === undefined ? repoPyProject() : join(res, 'py');
  const config = () => readConfig(env);
  const { dir: projectsDir } = resolveProjectsDir({
    env,
    config: (await config()).projectsDir,
    home: env['HOME'],
  });
  await ensureProjectsDir(projectsDir);
  const home = voxHome(env);
  const stylesDirs = [init.builtinStyles, join(home, 'styles')];
  const toolsDir =
    env['VOX_TOOLS_DIR'] ??
    join(env['HOME'] ?? homedir(), 'Library', 'Application Support', 'Vox Studio', 'tools');
  // tools look for each other on PATH (yt-dlp finds deno as its JS runtime): <tools>/bin first
  env['PATH'] = [join(toolsDir, 'bin'), env['PATH']].filter(Boolean).join(delimiter);
  // One live map: setup updates it in place as tools get installed (the engine reads it at use).
  const tools: Record<string, string | undefined> = resolveToolPaths({
    toolsDir,
    env,
    pyProject: pyDir,
  });
  if (res !== undefined) tools['node'] = process.execPath;
  const engine = openEngine({
    projectsDir,
    stylesDirs,
    tools,
    // phase 06 handoff: the app trusts styles through <VOX_HOME>/trust.json, after asking the user
    trustFile: join(home, 'trust.json'),
    config,
  });
  // setup events go out once `serve` exists (the handlers need `setup` first)
  const out: { emit?: ReturnType<typeof serve> } = {};
  const setup = new AppSetup({
    toolsDir,
    pyDir,
    ...(res === undefined ? {} : { bundledUvPath: join(res, 'bin', 'uv') }),
    env,
    tools,
    packaged: res !== undefined,
    emit: (e) => out.emit?.('setup.progress', e),
    doctor: (o) => engine.doctor(o),
    delegates: { chrome: chromeDelegate({ node: process.execPath, cli: hyperframesBin(), env }) },
    // VOX_UPDATE_REPO='' turns the check off (tests); unset uses the project repo (D-02)
    updateRepo: env['VOX_UPDATE_REPO'] ?? UPDATE_REPO,
    currentVersion: init.appVersion,
  });
  const preview = new PreviewPipeline(engine, (n, p) => out.emit?.(n, engine.redactor.redact(p)));
  // test builds (VOX_E2E=1, unpackaged) seed the quick path from the checked-in fixtures (D-16);
  // VOX_E2E_NO_SEED=1 runs it unseeded (the M5-only `local` E2E)
  const seeds =
    res === undefined && env['VOX_E2E'] === '1' && env['VOX_E2E_NO_SEED'] !== '1'
      ? { dir: join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'engine', 'test', 'fixtures') }
      : undefined;
  const appJobs = new AppJobs(engine, (n, p) => out.emit?.(n, engine.redactor.redact(p)), seeds);
  const emit = serve(port, createHandlers(engine, setup, { preview, appJobs }), (v) =>
    engine.redactor.redact(v),
  );
  out.emit = emit;
  forwardEvents(engine, emit);
  process.once('exit', () => setup.stop());
  port.postMessage({ ready: { projectsDir, stylesDirs, pid: process.pid } } satisfies HostReady);
  void setup.onLaunch();
}
