// Engine host: runs in an Electron utilityProcess (app spec "Architecture"). Main sends one message
// with the init data and a MessagePort; the host opens the engine and serves window.vox calls on
// that port. All jobs, file I/O and (later) network and keys live here, never in main.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openEngine, readConfig, resolveToolPaths, voxHome } from '@vox/engine';
import { ensureProjectsDir, resolveProjectsDir } from '@vox/engine/paths';
import { createHandlers, forwardEvents } from './handlers.ts';
import { serve, type PortLike } from './rpc.ts';

export interface HostInit {
  /** Built-in styles folder (repo `styles/` in dev, `Resources/styles` when packaged). */
  builtinStyles: string;
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
  const engine = openEngine({
    projectsDir,
    stylesDirs,
    tools: resolveToolPaths({ toolsDir, env }),
    // phase 06 handoff: the app trusts styles through <VOX_HOME>/trust.json, after asking the user
    trustFile: join(home, 'trust.json'),
    config,
  });
  const emit = serve(port, createHandlers(engine));
  forwardEvents(engine, emit);
  port.postMessage({ ready: { projectsDir, stylesDirs, pid: process.pid } } satisfies HostReady);
}
