// Engine host: runs in an Electron utilityProcess (app spec "Architecture"). Main sends one message
// with the init data and a MessagePort; the host opens the engine and serves window.vox calls on
// that port. All jobs, file I/O and (later) network and keys live here, never in main.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  createSecurityKeychain,
  engineConfigIO,
  registerStyleExtract,
  setWorkflowsDir,
  type AgentConfigDeps,
  type AppleModelOptions,
  type Keychain,
  type RoleModel,
} from '@vox/agent';
import {
  type Engine,
  VoxError,
  hyperframesBin,
  imagegenStatus,
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
import type { EventName } from '../shared/api.ts';
import { AgentHost } from './agent.ts';
import { e2eAgentModel } from './e2e-agent.ts';
import { e2eStyleSteps, e2eVisionRole } from './e2e-style.ts';
import { SettingsHost } from './settings.ts';

/** Test builds: keys stay in memory (the user's Keychain is never touched by a test). */
function memoryKeychain(): Keychain {
  const items = new Map<string, string>();
  return {
    get: (id) => Promise.resolve(items.get(id) ?? null),
    set: (id, key) => {
      items.set(id, key);
      return Promise.resolve();
    },
    remove: (id) => {
      items.delete(id);
      return Promise.resolve();
    },
  };
}

/** `<resources>/build-info.json` (written by stage-resources): what this build bundles. */
function readBuildInfo(res: string | undefined): { appleHelper?: boolean } | undefined {
  if (res === undefined) return undefined;
  try {
    const v = JSON.parse(readFileSync(join(res, 'build-info.json'), 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as { appleHelper?: boolean }) : undefined;
  } catch {
    return { appleHelper: false };
  }
}

/**
 * The Apple helper: `VOX_APPLE_LLM` (unpackaged builds only); else `<resources>/bin/vox-apple-llm`;
 * else the dev build in `native/apple-llm`. Undefined when the file does not exist.
 */
function appleHelperPath(
  env: NodeJS.ProcessEnv,
  res: string | undefined,
): AppleModelOptions | undefined {
  const fromEnv = res === undefined ? env['VOX_APPLE_LLM'] : undefined;
  if (fromEnv) {
    // test builds: `node <fake-apple-llm.mjs>` (the fake helper is a script)
    return fromEnv.endsWith('.mjs')
      ? {
          command: process.execPath,
          args: [fromEnv],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            ...(env['VOX_FAKE_APPLE_STATUS'] && {
              VOX_FAKE_APPLE_STATUS: env['VOX_FAKE_APPLE_STATUS'],
            }),
          },
        }
      : { command: fromEnv };
  }
  const path =
    res !== undefined
      ? join(res, 'bin', 'vox-apple-llm')
      : join(
          import.meta.dirname,
          '..',
          '..',
          '..',
          '..',
          'native',
          'apple-llm',
          '.build',
          'release',
          'vox-apple-llm',
        );
  return existsSync(path) ? { command: path } : undefined;
}

/** Test builds: the role of the mock agent model (free, a large context). */
function e2eRole(): RoleModel {
  return {
    model: e2eAgentModel(),
    provider: { type: 'ollama', label: 'E2E mock' },
    modelId: 'e2e-mock',
    contextTokens: 128_000,
    price: { free: true },
    maxOutputTokens: 8_000,
  } as RoleModel;
}

/** One engine job, awaited (the agent's default job runner). */
async function engineJob(
  engine: Engine,
  kind: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const id = engine.jobs.start(kind, args);
  const onAbort = () => engine.jobs.cancel(id);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const info = await engine.jobs.wait(id);
    if (info.status === 'done') return info.result;
    const e = info.error;
    throw new VoxError(
      e?.code ?? (info.status === 'cancelled' ? 'CANCELLED' : 'JOB_FAILED'),
      e?.message ?? `job ${kind} ${info.status}`,
      e?.hint ?? 'Try again.',
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

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
  // the Apple helper if this build has one: the agent's Apple provider and the engine's video
  // highlights (D-75) use it
  const apple = appleHelperPath(env, res);
  const appleHelper = readBuildInfo(res)?.appleHelper ?? apple !== undefined;
  const engine = openEngine({
    projectsDir,
    stylesDirs,
    tools,
    // phase 06 handoff: the app trusts styles through <VOX_HOME>/trust.json, after asking the user
    trustFile: join(home, 'trust.json'),
    config,
    ...(apple && appleHelper && { appleHelper: apple }),
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
      ? {
          dir: join(
            import.meta.dirname,
            '..',
            '..',
            '..',
            '..',
            'packages',
            'engine',
            'test',
            'fixtures',
          ),
        }
      : undefined;
  // The agent (phase 13): workflow prompts from Resources when packaged; keys in the login Keychain
  // (test builds: in memory, never the user's Keychain); the Apple helper if this build has one.
  if (res !== undefined) setWorkflowsDir(join(res, 'agent', 'workflows'));
  const testBuild = res === undefined && env['VOX_E2E'] === '1';
  const cfg: AgentConfigDeps = {
    io: engineConfigIO(env),
    keychain: testBuild ? memoryKeychain() : createSecurityKeychain(),
    env,
    redactor: engine.redactor,
  };
  const mock = testBuild && env['VOX_E2E_AGENT'] === 'mock';
  const agentEmit = (n: EventName, p: unknown) => out.emit?.(n, engine.redactor.redact(p));
  // quick clips score with the agent's fast model; the agent host is made after the job runner
  const late: { agent?: AgentHost } = {};
  const appJobs = new AppJobs(engine, agentEmit, seeds, () =>
    late.agent ? late.agent.quickScorer() : Promise.resolve(undefined),
  );
  const agent = new AgentHost({
    engine,
    cfg,
    ...(apple && appleHelper && { apple }),
    emit: agentEmit,
    ...(mock && {
      models: () =>
        Promise.resolve({
          models: { editor: e2eRole() },
          mode: env['VOX_E2E_AGENT_MODE'] === 'plan' ? ('plan' as const) : ('tools' as const),
        }),
    }),
    ...(seeds && {
      runJob: async (kind: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        const projectId = args['projectId'];
        const mediaId = args['mediaId'];
        if (typeof projectId === 'string' && typeof mediaId === 'string') {
          const by = {
            actor: args['actor'] === 'agent' ? ('agent' as const) : ('user' as const),
            ...(typeof args['runId'] === 'string' && { runId: args['runId'] }),
          };
          if (await appJobs.seedStage(kind, { projectId, mediaId }, by)) return { mediaId };
        }
        return engineJob(engine, kind, args, signal);
      },
    }),
  });
  late.agent = agent;
  // style extraction (phase 15): the job runs in this engine with the vision model of Settings;
  // test builds with the mock agent use the fixture reference and a mock vision model
  registerStyleExtract(
    engine,
    agent.styleExtractHost(mock ? () => Promise.resolve(e2eVisionRole()) : undefined),
    mock && seeds ? e2eStyleSteps(seeds.dir) : {},
  );
  const settings = new SettingsHost({
    cfg,
    imagegen: async () => ({
      models: (await imagegenStatus(tools['models'])).map((m) => ({
        id: m.id,
        label: m.label,
        license: m.license,
        licenseUrl: m.licenseUrl,
        gated: m.gated,
        installed: m.installed,
        downloadBytes: m.downloadBytes,
        installedBytes: m.installedBytes,
        sizeOnDisk: m.sizeOnDisk,
        partialBytes: m.partialBytes,
      })),
    }),
    appleHelper: appleHelper && apple !== undefined,
    ...(apple && { apple }),
  });
  if (mock) {
    // the renderer sees the mock as the editor model (mode indicator, "Add style beats")
    const real = settings.get.bind(settings);
    settings.get = async () => {
      const d = await real();
      return {
        ...d,
        roles: { ...d.roles, editor: { providerId: 'e2e', model: 'e2e-mock' } },
        mode: env['VOX_E2E_AGENT_MODE'] === 'plan' ? 'plan' : 'tools',
      };
    };
  }
  const emit = serve(
    port,
    createHandlers(engine, setup, {
      preview,
      appJobs,
      agent,
      settings,
      styleExtract: { render: !testBuild },
    }),
    (v) => engine.redactor.redact(v),
  );
  out.emit = emit;
  forwardEvents(engine, emit);
  process.once('exit', () => setup.stop());
  port.postMessage({ ready: { projectsDir, stylesDirs, pid: process.pid } } satisfies HostReady);
  void setup.onLaunch();
}
