// `vox` command line: a thin wrapper over the engine API (engine spec "Library API"). Every command
// takes --json and --projects-dir. A VoxError exits 1 and prints its hint (--json: the error object);
// usage errors exit 2.
import { spawn as spawnChild } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { selfTest } from './self-test.ts';
import {
  isVoxError,
  classifyUrl,
  openEngine,
  readConfig,
  resolveProjectsDir,
  resolveToolPaths,
  toVoxErrorJson,
  version,
  VoxError,
  type Actor,
  type ApplyResult,
  type Engine,
  type EngineOptions,
  type HistoryEntry,
  type JobInfo,
  writeConfig,
} from '@vox/engine';
import { appleHelper, configCommand, ConfigUsageError, type AgentCliDeps } from './config.ts';
import { agentCommand, AgentUsageError } from './agent.ts';

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** Interactive terminal (stdin and stdout); `vox doctor` asks for the contact only then. */
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
  /** Reads one line without echo (`vox config providers add`: API keys). */
  promptSecret?: (question: string) => Promise<string>;
  /** Runs a child with the terminal attached and resolves its exit code (`vox preview`). */
  spawn?: (command: string, args: readonly string[], opts: { cwd: string }) => Promise<number>;
  /** Extra engine options (tests: a HyperFrames stand-in). */
  engine?: Partial<EngineOptions>;
  /** `vox config` seams (tests: a memory Keychain, probe checks, no Apple helper). */
  agent?: Partial<AgentCliDeps>;
  /**
   * The app's Resources folder when this CLI runs bundled in Vox Studio (plan R1 "Packaged app"):
   * built-in styles, `py/`, the bundled uv and Electron-as-Node come from there.
   */
  resources?: string;
}

/** One line from a terminal without echo; Ctrl-C or Ctrl-D ends with an empty answer. */
function readHidden(question: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(question);
  return new Promise((done) => {
    let text = '';
    const finish = (value: string) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      done(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(text);
        if (ch === '\u0003' || ch === '\u0004') return finish('');
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

export const defaultIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  },
  promptSecret: readHidden,
  spawn: (command, args, opts) =>
    new Promise((done, fail) => {
      const child = spawnChild(command, [...args], { cwd: opts.cwd, stdio: 'inherit' });
      child.on('error', fail);
      child.on('exit', (code) => done(code ?? 1));
    }),
};

const USAGE = `usage:
  vox new <name>                          create a project with a 9:16 sequence
  vox op <project> <op> [<args-json>]     apply an edit op (or batch)
       [--actor user|agent|cli] [--run-id <id>] [--base-version <n>] [--coalesce-key <k>]
  vox undo <project> [--run <runId>]      undo the last edit (or an agent run)
  vox redo <project>
  vox history <project> [--since <version>]
  vox snapshot <project> <name> | --list
  vox paths                               print the projects folder, styles folders and tools
  vox ingest <project> <path|url>...      add files, folders or links [--playlist] [--no-proxies]
  vox transcribe <project> <mediaId>      words + speech regions [--language <code>]
  vox shots <project> <mediaId>           shot cuts (scdet)
  vox facetrack <project> <mediaId>       face, body and saliency detections
  vox media-frames <project> <mediaId> --at-ms <ms>[,<ms>...]   PNG stills (paths)
  vox doctor [<project>] [--unlock] [--quick]   check tools, models, config (and a project)
  vox self-test                           check the files this build ships with (styles, data, runtime)
  vox quick <url|path> [--count 3] [--length 30-60] [--name n] [--render] [--out-dir dir]
                                          new project → ingest, shots, transcribe, facetrack → clips
  vox assets search <project> "<query>" [--source commons,openverse] [--limit n]
  vox assets fetch <project> <candidateId>
  vox assets cutout <project> <mediaId>
  vox assets generate <project> "<prompt>" [--style id] [--provider id]
  vox compile <project> [--seq id] [--mode preview|render]   writes build/
  vox preview <project> [--seq id]        compile + npx hyperframes play
  vox frames <project> [--seq id] --at-ms <ms>[,<ms>...]     compiled stills (paths)
  vox render <project> [--seq id | --all] [--range-ms a-b] [--quality draft|standard|high]
       [--captions burn|none] [--loudness youtube|tiktok|broadcast] [-o file | --out-dir dir] [--overwrite]
  vox audio-qa <project> [--seq id] [--loudness youtube|tiktok|broadcast] [--kit styleId]
  vox export-captions <project> [--seq id] --format srt|vtt [-o file | --out-dir dir] [--overwrite]
  vox export-timeline <project> [--seq id] [--format otio|fcpxml] [-o file | --out-dir dir] [--overwrite]
  vox credits <project>                   licence and attribution of the archive assets used
  vox style validate <style> [--no-render] [--no-dom]   check a style; writes its previews/
  vox style new <id> [--extends <style>] [--name <name>]   scaffold a draft user style
  vox style trust <id> [--yes]            allow a user style's build.mjs hook to run
  vox style accept <id> | remove <id>     mark a draft active | delete a user style
  vox config providers add <preset> [--key env:NAME] [--id id] [--base-url url]
       [--context <model>=<tokens>]... [--num-ctx n]   (no --key: the key is asked for, hidden)
  vox config providers list | remove <id>
  vox config roles set <role> <provider>:<model> [--mode tools|plan]   probes first; refuses a failed role
  vox config prices set <model> --in <usd> --out <usd> | --free        per million tokens
  vox config probe [<provider>:<model>...]   probe the role models (or the named ones)
  vox agent <project> ["<instruction>"] [--workflow clipper|stylize|edit] [--seq id]... [--style id]
       [--layout full-collage|hybrid] [--mode tools|plan] [--max-usd 2] [--yes-sources] [--yes] [--confirm-plan]
       [--count n] [--length 30-60]   (clipper: number of clips, length in seconds)
  vox agent undo <project> <runId>        undo every edit of an agent run
common options: --json, --projects-dir <dir>; <project> is an id or a unique name
`;

class UsageError extends Error {}

/** Actors a caller may claim; `external` is recorded only by the engine itself. */
const CLI_ACTORS = ['user', 'agent', 'cli'] as const satisfies readonly Actor[];

/** Text output drops terminal control characters (names and messages come from project files). */
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

const COMMON = {
  json: { type: 'boolean' },
  'projects-dir': { type: 'string' },
} as const satisfies ParseArgsConfig['options'];

const OPTIONS: Record<string, ParseArgsConfig['options']> = {
  new: COMMON,
  op: {
    ...COMMON,
    actor: { type: 'string' },
    'run-id': { type: 'string' },
    'base-version': { type: 'string' },
    'coalesce-key': { type: 'string' },
  },
  undo: { ...COMMON, run: { type: 'string' } },
  redo: COMMON,
  history: { ...COMMON, since: { type: 'string' } },
  snapshot: { ...COMMON, list: { type: 'boolean' } },
  paths: COMMON,
  ingest: { ...COMMON, playlist: { type: 'boolean' }, 'no-proxies': { type: 'boolean' } },
  transcribe: { ...COMMON, language: { type: 'string' } },
  shots: COMMON,
  facetrack: COMMON,
  'media-frames': { ...COMMON, 'at-ms': { type: 'string' } },
  doctor: { ...COMMON, unlock: { type: 'boolean' }, quick: { type: 'boolean' } },
  'self-test': COMMON,
  quick: {
    ...COMMON,
    count: { type: 'string' },
    length: { type: 'string' },
    name: { type: 'string' },
    render: { type: 'boolean' },
    'out-dir': { type: 'string' },
  },
  assets: {
    ...COMMON,
    source: { type: 'string' },
    limit: { type: 'string' },
    style: { type: 'string' },
    provider: { type: 'string' },
  },
  compile: { ...COMMON, seq: { type: 'string' }, mode: { type: 'string' } },
  preview: { ...COMMON, seq: { type: 'string' } },
  frames: { ...COMMON, seq: { type: 'string' }, 'at-ms': { type: 'string' } },
  render: {
    ...COMMON,
    seq: { type: 'string' },
    all: { type: 'boolean' },
    'range-ms': { type: 'string' },
    quality: { type: 'string' },
    captions: { type: 'string' },
    loudness: { type: 'string' },
    output: { type: 'string', short: 'o' },
    'out-dir': { type: 'string' },
    overwrite: { type: 'boolean' },
  },
  'audio-qa': {
    ...COMMON,
    seq: { type: 'string' },
    loudness: { type: 'string' },
    kit: { type: 'string' },
  },
  'export-captions': {
    ...COMMON,
    seq: { type: 'string' },
    format: { type: 'string' },
    output: { type: 'string', short: 'o' },
    'out-dir': { type: 'string' },
    overwrite: { type: 'boolean' },
  },
  'export-timeline': {
    ...COMMON,
    seq: { type: 'string' },
    format: { type: 'string' },
    output: { type: 'string', short: 'o' },
    'out-dir': { type: 'string' },
    overwrite: { type: 'boolean' },
  },
  credits: COMMON,
  agent: {
    ...COMMON,
    workflow: { type: 'string' },
    seq: { type: 'string', multiple: true },
    style: { type: 'string' },
    layout: { type: 'string' },
    mode: { type: 'string' },
    'max-usd': { type: 'string' },
    'yes-sources': { type: 'boolean' },
    yes: { type: 'boolean' },
    'confirm-plan': { type: 'boolean' },
    count: { type: 'string' },
    length: { type: 'string' },
  },
  config: {
    json: { type: 'boolean' },
    key: { type: 'string' },
    id: { type: 'string' },
    'base-url': { type: 'string' },
    context: { type: 'string', multiple: true },
    'num-ctx': { type: 'string' },
    mode: { type: 'string' },
    in: { type: 'string' },
    out: { type: 'string' },
    free: { type: 'boolean' },
  },
  style: {
    ...COMMON,
    extends: { type: 'string' },
    name: { type: 'string' },
    yes: { type: 'boolean' },
    'no-render': { type: 'boolean' },
    'no-dom': { type: 'boolean' },
  },
};

interface Parsed {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

function parse(cmd: string, args: readonly string[]): Parsed {
  try {
    const r = parseArgs({
      args: [...args],
      options: OPTIONS[cmd]!,
      allowPositionals: true,
      strict: true,
    });
    return { values: r.values as Parsed['values'], positionals: r.positionals };
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function int(v: string | boolean | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^\d+$/.test(v))
    throw new UsageError(`--${name} must be a whole number`);
  return Number(v);
}

function need(positionals: string[], n: number, what: string): void {
  if (positionals.length < n) throw new UsageError(`missing ${what}`);
}

/** A flag that takes one of a fixed set of words. */
function oneOf<T extends string>(
  v: string | boolean | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
    throw new UsageError(`--${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

const seqArg = (values: Parsed['values']) =>
  typeof values['seq'] === 'string' ? { sequenceId: values['seq'] } : {};

/** `-o file` or `--out-dir dir` (made absolute against the current folder), plus `--overwrite`. */
function targetArg(values: Parsed['values'], io: Io) {
  const file = values['output'];
  const dir = values['out-dir'];
  if (file !== undefined && dir !== undefined)
    throw new UsageError('pass -o <file> or --out-dir <dir>, not both');
  return {
    ...(typeof file === 'string' ? { target: { file: resolve(io.cwd, file) } } : {}),
    ...(typeof dir === 'string' ? { target: { dir: resolve(io.cwd, dir) } } : {}),
    ...(values['overwrite'] === true ? { overwrite: true } : {}),
  };
}

/** `a-b` with whole numbers (`--range-ms`), or seconds with decimals (`--length`). */
function span(
  v: string | boolean | undefined,
  name: string,
  scale: number,
): [number, number] | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(v) : null;
  if (!m || (scale === 1 && /\./.test(v as string)))
    throw new UsageError(`--${name} takes <from>-<to>`);
  const a = Math.round(Number(m[1]) * scale);
  const b = Math.round(Number(m[2]) * scale);
  if (b <= a) throw new UsageError(`--${name}: <to> must be after <from>`);
  return [a, b];
}

const LOUDNESS = ['youtube', 'tiktok', 'broadcast'] as const;

interface RenderOut {
  files: { sequenceId: string; path: string; durationMs: number }[];
}

function toolsDir(io: Io): string {
  return (
    io.env['VOX_TOOLS_DIR'] ??
    join(io.env['HOME'] ?? homedir(), 'Library', 'Application Support', 'Vox Studio', 'tools')
  );
}

const voxHomeOf = (io: Io) => io.env['VOX_HOME'] ?? join(io.env['HOME'] ?? homedir(), '.vox');

function stylesDirs(io: Io): string[] {
  const builtIn =
    io.resources === undefined
      ? fileURLToPath(new URL('../../../styles', import.meta.url))
      : join(io.resources, 'styles');
  return [builtIn, join(voxHomeOf(io), 'styles')];
}

/** Tool paths; a bundled CLI uses the app's uv and `py/`, and the app's Electron as Node. */
function toolPathsFor(io: Io): Record<string, string | undefined> {
  if (io.resources === undefined) return resolveToolPaths({ toolsDir: toolsDir(io), env: io.env });
  const tools = resolveToolPaths({
    toolsDir: toolsDir(io),
    env: io.env,
    pyProject: join(io.resources, 'py'),
  });
  return { ...tools, uv: join(io.resources, 'bin', 'uv'), node: process.execPath };
}

async function engineFor(values: Parsed['values'], io: Io): Promise<Engine> {
  const flag = values['projects-dir'];
  const config = () => readConfig(io.env);
  const { dir } = resolveProjectsDir({
    flag: typeof flag === 'string' ? flag : undefined,
    env: io.env,
    config: (await config()).projectsDir,
    home: io.env['HOME'],
    cwd: io.cwd,
  });
  return openEngine({
    projectsDir: dir,
    stylesDirs: stylesDirs(io),
    tools: toolPathsFor(io),
    trustFile: join(voxHomeOf(io), 'trust.json'),
    config,
    ...io.engine,
  });
}

/** Runs one engine job to the end; progress goes to stderr on a terminal; a failure throws its VoxError. */
async function runJob<R>(
  e: Engine,
  kind: string,
  args: unknown,
  io: Io,
  json: boolean,
): Promise<R> {
  const id = e.jobs.start(kind, args);
  const off =
    io.isTTY && !json
      ? e.on('job.progress', (p) => {
          if (p.jobId === id) {
            const text = clean(`${kind} ${Math.round(p.progress * 100)}% ${p.message ?? ''}`);
            io.stderr(`\r${text}\x1b[K`);
          }
        })
      : () => undefined;
  let info: JobInfo;
  try {
    info = await e.jobs.wait(id);
  } finally {
    off();
    if (io.isTTY && !json) io.stderr('\r\x1b[K');
  }
  if (info.status !== 'done') {
    const err = info.error;
    if (err)
      throw new VoxError(
        err.code,
        err.message,
        err.hint,
        err.details ? { details: err.details } : {},
      );
    throw new VoxError('CANCELLED', `${kind} was cancelled`, 'Run it again');
  }
  return info.result as R;
}

/** `<project>`: an id, or the name of exactly one project. */
async function resolveProject(engine: Engine, ref: string): Promise<string> {
  const list = await engine.listProjects();
  if (list.some((p) => p.id === ref)) return ref;
  const ids = list.filter((p) => p.name === ref).map((p) => p.id);
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) {
    throw new VoxError(
      'PROJECT_AMBIGUOUS',
      `${ids.length} projects are named ${JSON.stringify(ref)}: ${ids.join(', ')}`,
      'Use the project id instead of the name',
      { details: { ids } },
    );
  }
  throw new VoxError(
    'PROJECT_NOT_FOUND',
    `No project with id or name ${JSON.stringify(ref)}`,
    'Check the name, or the projects folder with `vox paths`',
  );
}

/** Print an ApplyResult; exit 1 when any op did not succeed. */
function printResult(r: ApplyResult, json: boolean, io: Io): number {
  const bad = r.results.filter((x) => x.status !== 'succeeded');
  if (json) io.stdout(`${JSON.stringify(r, null, 2)}\n`);
  else if (bad.length === 0) io.stdout(`ok: version ${r.version}, ${r.changes.length} change(s)\n`);
  for (const x of bad) {
    if (!json && x.error)
      io.stderr(clean(`error: ${x.op} ${x.status}: ${x.error.message}\nhint: ${x.error.hint}\n`));
  }
  if (!json && bad.length > 0 && bad.every((x) => !x.error))
    io.stderr('error: the batch was not applied\n');
  return bad.length === 0 ? 0 : 1;
}

function historyLine(e: HistoryEntry): string {
  const what = e.kind === 'op' ? e.op : `${e.kind} ${(e.targets ?? []).join(',')}`;
  return `${e.version}\t${e.ts}\t${e.actor}${e.runId ? `/${e.runId}` : ''}\t${what}\t${e.changes.length} change(s)\n`;
}

async function command(cmd: string, args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = parse(cmd, args);
  const json = values['json'] === true;
  const out = (v: unknown, text: string) =>
    io.stdout(json ? `${JSON.stringify(v, null, 2)}\n` : clean(text));
  switch (cmd) {
    case 'self-test': {
      const pyDir = toolPathsFor(io)['py'];
      if (pyDir === undefined) throw new Error('no uv project (py/) found');
      const r = await selfTest({
        ...(io.resources === undefined ? {} : { resources: io.resources }),
        stylesDirs: stylesDirs(io).slice(0, 1),
        pyDir,
        ...(io.resources === undefined && {
          appleHelper: (io.agent && 'apple' in io.agent ? io.agent.apple : appleHelper(io))
            ?.command,
        }),
      });
      const mark = { passed: 'ok  ', failed: 'FAIL', skipped: 'skip', notBuilt: 'skip' } as const;
      out(r, r.checks.map((c) => `${mark[c.status]} ${c.name}: ${c.detail}\n`).join(''));
      return r.ok ? 0 : 1;
    }
    case 'paths': {
      const e = await engineFor(values, io);
      out(
        {
          projectsDir: e.projectsDir,
          stylesDirs: e.stylesDirs,
          tools: { dir: toolsDir(io), ...e.tools },
        },
        `projects: ${e.projectsDir}\nstyles: ${e.stylesDirs.join(', ')}\ntools: ${toolsDir(io)}\n`,
      );
      return 0;
    }
    case 'new': {
      need(positionals, 1, '<name>');
      const name = positionals[0]!;
      const e = await engineFor(values, io);
      const p = await e.createProject(name);
      const r = await e.applyOp(
        p.id,
        { op: 'addSequence', args: { name: 'Main', styleId: e.styles.defaultId() } },
        { actor: 'cli' },
      );
      const failed = r.results.find((x) => x.status !== 'succeeded');
      if (failed?.error) {
        const { code, message, hint, details } = failed.error;
        throw new VoxError(code, message, hint, details === undefined ? {} : { details });
      }
      const sequenceId = (r.results[0]?.report as { sequenceId?: string } | undefined)?.sequenceId;
      out(
        { id: p.id, name, version: r.version, sequenceId },
        `created ${name} (${p.id}) with sequence ${sequenceId}\n`,
      );
      return 0;
    }
    case 'op': {
      need(positionals, 2, '<project> <op>');
      const [ref, op, raw] = positionals as [string, string, string | undefined];
      let opArgs: unknown = {};
      if (raw !== undefined) {
        try {
          opArgs = JSON.parse(raw);
        } catch {
          throw new UsageError('<args-json> is not valid JSON');
        }
      }
      const actor = (values['actor'] as string | undefined) ?? 'cli';
      if (!(CLI_ACTORS as readonly string[]).includes(actor))
        throw new UsageError(`--actor must be one of ${CLI_ACTORS.join(', ')}`);
      const baseVersion = int(values['base-version'], 'base-version');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, ref);
      const r = await e.applyOp(
        id,
        { op, args: opArgs },
        {
          actor: actor as Actor,
          ...(typeof values['run-id'] === 'string' ? { runId: values['run-id'] } : {}),
          ...(baseVersion === undefined ? {} : { baseVersion }),
          ...(typeof values['coalesce-key'] === 'string'
            ? { coalesceKey: values['coalesce-key'] }
            : {}),
        },
      );
      return printResult(r, json, io);
    }
    case 'undo':
    case 'redo': {
      need(positionals, 1, '<project>');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const opts = { actor: 'cli' as const };
      const run = values['run'];
      const r =
        cmd === 'redo'
          ? await e.redo(id, opts)
          : typeof run === 'string'
            ? await e.undoRun(id, run, opts)
            : await e.undo(id, opts);
      return printResult(r, json, io);
    }
    case 'history': {
      need(positionals, 1, '<project>');
      const since = int(values['since'], 'since');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const entries = await e.history(id, since === undefined ? {} : { sinceVersion: since });
      out(entries, entries.map(historyLine).join(''));
      return 0;
    }
    case 'snapshot': {
      need(positionals, 1, '<project>');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      if (values['list'] === true) {
        const list = await e.listSnapshots(id);
        out(list, list.map((s) => `${s.name}\tversion ${s.version ?? '?'}\n`).join(''));
        return 0;
      }
      need(positionals, 2, '<name> (or --list)');
      const s = await e.snapshot(id, positionals[1]!);
      out(s, `saved snapshot ${s.name} (version ${s.version})\n`);
      return 0;
    }
    case 'ingest': {
      need(positionals, 2, '<project> <path|url>...');
      const [ref, ...rawInputs] = positionals as [string, ...string[]];
      // Links pass as they are; local paths are made absolute against the current folder.
      const inputs = rawInputs.map((s) =>
        classifyUrl(s) !== 'invalid' || /^[a-z][a-z0-9+.-]*:/i.test(s) || isAbsolute(s)
          ? s
          : resolve(io.cwd, s),
      );
      const e = await engineFor(values, io);
      const id = await resolveProject(e, ref);
      const r = await runJob<{
        media: { input: string; mediaId: string; kind: string; reused: boolean }[];
        posts: { url: string; count: number; taken: number }[];
        skipped: { path: string; reason: string }[];
        version: number;
      }>(
        e,
        'ingest',
        {
          projectId: id,
          inputs,
          ...(values['playlist'] === true ? { playlist: true } : {}),
          ...(values['no-proxies'] === true ? { proxies: false } : {}),
          actor: 'cli',
        },
        io,
        json,
      );
      out(
        r,
        [
          ...r.media.map(
            (m) => `${m.mediaId}\t${m.kind}\t${m.reused ? 'reused' : 'added'}\t${m.input}\n`,
          ),
          ...r.posts.map(
            (p) =>
              `note: ${p.url} has ${p.count} videos; took ${p.taken} (use --playlist for all)\n`,
          ),
          ...r.skipped.map((s) => `skipped (${s.reason}): ${s.path}\n`),
          `version ${r.version}\n`,
        ].join(''),
      );
      return 0;
    }
    case 'transcribe':
    case 'shots':
    case 'facetrack': {
      need(positionals, 2, '<project> <mediaId>');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const lang = values['language'];
      const r = await runJob<Record<string, unknown>>(
        e,
        cmd,
        {
          projectId: id,
          mediaId: positionals[1]!,
          actor: 'cli',
          ...(typeof lang === 'string' ? { language: lang } : {}),
        },
        io,
        json,
      );
      const file = r['transcriptPath'] ?? r['shotsPath'] ?? r['facetrackPath'];
      out(r, `${String(file)}${r['cached'] ? ' (cached)' : ''}\tversion ${String(r['version'])}\n`);
      return 0;
    }
    case 'media-frames': {
      need(positionals, 2, '<project> <mediaId>');
      const raw = values['at-ms'];
      if (typeof raw !== 'string' || !/^\d+(,\d+)*$/.test(raw))
        throw new UsageError('--at-ms takes whole ms values, comma separated');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const at = raw.split(',').map(Number);
      const paths = await e.mediaFrames(id, positionals[1]!, at);
      out(
        at.map((t, i) => ({ atMs: t, path: paths[i] })),
        paths.map((p, i) => `${at[i]}\t${p}\n`).join(''),
      );
      return 0;
    }
    case 'doctor': {
      const e = await engineFor(values, io);
      // Ask once, on a terminal only, for the Commons User-Agent contact (--json never asks).
      if (!json && io.isTTY && io.prompt && !(await readConfig(io.env)).contact) {
        const answer = (
          await io.prompt(
            'Contact (email or URL) for the Wikimedia Commons User-Agent, or Enter to skip: ',
          )
        ).trim();
        if (answer !== '') await writeConfig({ contact: answer }, io.env);
      }
      const report = await e.doctor(values['quick'] === true ? { quick: true } : {});
      let project: unknown;
      if (positionals[0] !== undefined) {
        const id = await resolveProject(e, positionals[0]);
        project = await e.doctorProject(id, values['unlock'] === true ? { unlock: true } : {});
      }
      const mark = { ok: 'ok  ', warn: 'WARN', error: 'FAIL' } as const;
      const lines = report.checks.map(
        (c) => `${mark[c.level]} ${c.name}: ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ''}\n`,
      );
      if (project) {
        const p = project as {
          orphanOverrides: { sequenceId: string; wordKey: string; reason: string }[];
          lock: { host: string; pid: number; removed?: boolean } | null;
        };
        for (const o of p.orphanOverrides)
          lines.push(`WARN caption override ${o.wordKey} in ${o.sequenceId}: ${o.reason}\n`);
        if (p.lock)
          lines.push(
            p.lock.removed
              ? `ok   lock of ${p.lock.host} (pid ${p.lock.pid}) removed\n`
              : `WARN locked by ${p.lock.host} (pid ${p.lock.pid}); --unlock removes it\n`,
          );
      }
      out(project ? { ...report, project } : report, lines.join(''));
      return report.ok ? 0 : 1;
    }
    case 'assets': {
      need(positionals, 3, '<search|fetch|cutout|generate> <project> <argument>');
      const [sub, ref, arg] = positionals as [string, string, string];
      const e = await engineFor(values, io);
      const id = await resolveProject(e, ref);
      if (sub === 'search') {
        const sources =
          typeof values['source'] === 'string' ? values['source'].split(',') : undefined;
        const limit = int(values['limit'], 'limit');
        const r = await runJob<{
          candidates: {
            id: string;
            title: string;
            author?: string;
            license: string;
            source: string;
          }[];
        }>(
          e,
          'assets.search',
          {
            projectId: id,
            query: arg,
            ...(sources ? { sources } : {}),
            ...(limit === undefined ? {} : { limit }),
          },
          io,
          json,
        );
        out(
          r,
          r.candidates
            .map((c) => `${c.id}\t${c.license}\t${c.title}${c.author ? ` (${c.author})` : ''}\n`)
            .join(''),
        );
        return 0;
      }
      if (sub === 'fetch' || sub === 'cutout') {
        const r = await runJob<{
          mediaId: string;
          license?: string;
          warning?: string;
          version: number;
        }>(
          e,
          `assets.${sub}`,
          {
            projectId: id,
            ...(sub === 'fetch' ? { candidateId: arg } : { mediaId: arg }),
            actor: 'cli',
          },
          io,
          json,
        );
        out(
          r,
          `${r.mediaId}${r.license ? `\t${r.license}` : ''}\tversion ${r.version}\n${r.warning ? `note: ${r.warning}\n` : ''}`,
        );
        return 0;
      }
      if (sub === 'generate') {
        const r = await runJob<{ mediaId: string; provider: string; version: number }>(
          e,
          'assets.generate',
          {
            projectId: id,
            prompt: arg,
            ...(typeof values['style'] === 'string' ? { styleId: values['style'] } : {}),
            ...(typeof values['provider'] === 'string' ? { provider: values['provider'] } : {}),
            actor: 'cli',
          },
          io,
          json,
        );
        out(r, `${r.mediaId}\t${r.provider}\tversion ${r.version}\n`);
        return 0;
      }
      throw new UsageError(`unknown assets command ${JSON.stringify(sub)}`);
    }
    case 'compile': {
      need(positionals, 1, '<project>');
      const mode = oneOf(values['mode'], 'mode', ['preview', 'render'] as const) ?? 'preview';
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const sequenceId =
        typeof values['seq'] === 'string'
          ? values['seq']
          : (await e.getProject(id)).sequences[0]?.id;
      if (!sequenceId)
        throw new VoxError(
          'NOT_FOUND',
          `Project ${id} has no sequence`,
          'Add one with `vox op addSequence`',
        );
      const b = await e.compile(id, sequenceId, { mode });
      const buildDir = await e.writeBuild(b);
      out(
        { sequenceId, mode, buildDir, warnings: b.warnings },
        `${buildDir}\n${b.warnings.map((w) => `warning: ${String(w)}\n`).join('')}`,
      );
      return 0;
    }
    case 'preview': {
      need(positionals, 1, '<project>');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const p = await e.preview(id, typeof values['seq'] === 'string' ? values['seq'] : undefined);
      if (json) out(p, '');
      else io.stderr(clean(`${p.command} ${p.args.join(' ')}\n`));
      if (!io.spawn) return 0;
      return await io.spawn(p.command, p.args, { cwd: p.buildDir });
    }
    case 'frames': {
      need(positionals, 1, '<project>');
      const raw = values['at-ms'];
      if (typeof raw !== 'string' || !/^\d+(,\d+)*$/.test(raw))
        throw new UsageError('--at-ms takes whole ms values, comma separated');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const at = raw.split(',').map(Number);
      const paths = await e.frames(
        id,
        typeof values['seq'] === 'string' ? values['seq'] : undefined,
        at,
      );
      out(
        at.map((t, i) => ({ atMs: t, path: paths[i] })),
        paths.map((p, i) => `${at[i]}\t${p}\n`).join(''),
      );
      return 0;
    }
    case 'render': {
      need(positionals, 1, '<project>');
      const range = span(values['range-ms'], 'range-ms', 1);
      const quality = oneOf(values['quality'], 'quality', ['draft', 'standard', 'high'] as const);
      const captions = oneOf(values['captions'], 'captions', ['burn', 'none'] as const);
      const loudness = oneOf(values['loudness'], 'loudness', LOUDNESS);
      if (values['all'] === true && values['seq'] !== undefined)
        throw new UsageError('pass --seq or --all, not both');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const r = await runJob<RenderOut>(
        e,
        'render',
        {
          projectId: id,
          ...seqArg(values),
          ...(values['all'] === true ? { all: true } : {}),
          ...(range ? { range: { startMs: range[0], endMs: range[1] } } : {}),
          ...(quality ? { quality } : {}),
          ...(captions ? { captions } : {}),
          ...(loudness ? { loudness } : {}),
          ...targetArg(values, io),
        },
        io,
        json,
      );
      out(r, r.files.map((f) => `${f.path}\t${f.durationMs} ms\n`).join(''));
      return 0;
    }
    case 'audio-qa': {
      need(positionals, 1, '<project>');
      const loudness = oneOf(values['loudness'], 'loudness', LOUDNESS);
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const r = await runJob<{
        pass?: boolean;
        outDir: string;
        png: string;
        checks?: { id: string; status: string }[];
        listen?: { timecode?: string; atMs: number; kind: string; listenFor: string }[];
        /** kit mode: one result per file; sequence mode: the names of the written files */
        files?: { path?: string; status?: string }[] | Record<string, string>;
      }>(
        e,
        'audioQa',
        {
          projectId: id,
          ...seqArg(values),
          ...(loudness ? { loudness } : {}),
          ...(typeof values['kit'] === 'string' ? { kit: values['kit'] } : {}),
        },
        io,
        json,
      );
      const lines = [
        ...(r.checks ?? []).map((c) => `${c.status.toUpperCase().padEnd(4)}\t${c.id}\n`),
        ...(Array.isArray(r.files) ? r.files : []).map(
          (f) => `${(f.status ?? '').toUpperCase().padEnd(4)}\t${f.path ?? ''}\n`,
        ),
        ...(r.listen ?? []).map(
          (l) => `listen ${l.timecode ?? `${l.atMs} ms`}\t${l.kind}: ${l.listenFor}\n`,
        ),
        `${r.outDir}\n`,
      ];
      out(r, lines.join(''));
      return r.pass === false ? 1 : 0;
    }
    case 'export-captions':
    case 'export-timeline': {
      need(positionals, 1, '<project>');
      const format =
        cmd === 'export-captions'
          ? oneOf(values['format'], 'format', ['srt', 'vtt'] as const)
          : oneOf(values['format'], 'format', ['otio', 'fcpxml'] as const);
      if (cmd === 'export-captions' && !format)
        throw new UsageError('--format srt|vtt is required');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const r = await runJob<{ path: string; layersDir?: string }>(
        e,
        cmd === 'export-captions' ? 'exportCaptions' : 'exportTimeline',
        {
          projectId: id,
          ...seqArg(values),
          ...(format ? { format } : {}),
          ...targetArg(values, io),
        },
        io,
        json,
      );
      out(r, `${r.path}\n${r.layersDir ? `${r.layersDir}\n` : ''}`);
      return 0;
    }
    case 'credits': {
      need(positionals, 1, '<project>');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const lines = await e.credits(id);
      out(
        lines,
        lines.length ? lines.map((l) => `${l.attribution}\n`).join('') : 'no archive assets used\n',
      );
      return 0;
    }
    case 'quick': {
      need(positionals, 1, '<url|path>');
      const raw = positionals[0]!;
      const input =
        classifyUrl(raw) !== 'invalid' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || isAbsolute(raw)
          ? raw
          : resolve(io.cwd, raw);
      const count = int(values['count'], 'count') ?? 3;
      const [minMs, maxMs] = span(values['length'], 'length', 1000) ?? [30_000, 60_000];
      const outDir =
        typeof values['out-dir'] === 'string' ? resolve(io.cwd, values['out-dir']) : undefined;
      if (outDir && values['render'] !== true) throw new UsageError('--out-dir needs --render');
      const name =
        typeof values['name'] === 'string'
          ? values['name']
          : classifyUrl(raw) === 'invalid'
            ? basename(input).replace(/\.[^.]+$/, '') || 'Quick clips'
            : 'Quick clips';
      const e = await engineFor(values, io);
      const p = await e.createProject(name);
      const ing = await runJob<{ media: { mediaId: string; kind: string }[] }>(
        e,
        'ingest',
        { projectId: p.id, inputs: [input], actor: 'cli' },
        io,
        json,
      );
      const media = ing.media.find((m) => m.kind === 'video');
      if (!media)
        throw new VoxError(
          'MEDIA_UNSUPPORTED',
          `${raw} is not a video`,
          'Pass a video file or link',
        );
      for (const kind of ['shots', 'transcribe', 'facetrack'])
        await runJob(e, kind, { projectId: p.id, mediaId: media.mediaId, actor: 'cli' }, io, json);
      const q = await runJob<{
        clips: { sequenceId: string; name: string; startMs: number; endMs: number; text: string }[];
        scorer: string;
        note?: string;
      }>(
        e,
        'quickClips',
        { projectId: p.id, mediaId: media.mediaId, count, minMs, maxMs, actor: 'cli' },
        io,
        json,
      );
      const files: { sequenceId: string; mp4: string; srt: string }[] = [];
      if (values['render'] === true) {
        for (const c of q.clips) {
          const target = outDir ? { target: { dir: outDir } } : {};
          const r = await runJob<RenderOut>(
            e,
            'render',
            { projectId: p.id, sequenceId: c.sequenceId, ...target },
            io,
            json,
          );
          const srt = await runJob<{ path: string }>(
            e,
            'exportCaptions',
            { projectId: p.id, sequenceId: c.sequenceId, format: 'srt', ...target },
            io,
            json,
          );
          files.push({ sequenceId: c.sequenceId, mp4: r.files[0]!.path, srt: srt.path });
        }
      }
      const lines = [
        `project ${p.id} (${name}); scorer ${q.scorer}\n`,
        ...q.clips.map(
          (c) => `${c.name}\t${c.sequenceId}\t${c.startMs}-${c.endMs} ms\t${c.text}\n`,
        ),
        ...(q.note ? [`note: ${q.note}\n`] : []),
        ...files.flatMap((f) => [`${f.mp4}\n`, `${f.srt}\n`]),
      ];
      out({ projectId: p.id, mediaId: media.mediaId, ...q, files }, lines.join(''));
      return 0;
    }
    case 'agent': {
      if (positionals[0] === 'undo') {
        need(positionals, 3, '<project> <runId>');
        const e = await engineFor(values, io);
        const id = await resolveProject(e, positionals[1]!);
        const r = await e.undoRun(id, positionals[2]!, { actor: 'user' });
        out(r, `undid run ${positionals[2]!} (version ${r.version})\n`);
        return 0;
      }
      need(positionals, 1, '<project>');
      if (positionals.length > 2)
        throw new UsageError('agent takes <project> and one quoted instruction');
      const e = await engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      try {
        return await agentCommand(e, id, positionals[1] ?? '', values, io);
      } catch (err) {
        if (err instanceof AgentUsageError) throw new UsageError(err.message);
        throw err;
      }
    }
    case 'style':
      return styleCommand(positionals, values, io, out);
    case 'config':
      try {
        return await configCommand(positionals, values, io);
      } catch (e) {
        if (e instanceof ConfigUsageError) throw new UsageError(e.message);
        throw e;
      }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
  }
}

/** `vox style validate|new|trust|accept|remove` (phase 06). */
async function styleCommand(
  positionals: string[],
  values: Parsed['values'],
  io: Io,
  out: (v: unknown, text: string) => void,
): Promise<number> {
  const [sub, id] = positionals;
  if (!sub || !['validate', 'new', 'trust', 'accept', 'remove'].includes(sub)) {
    throw new UsageError(`style needs validate, new, trust, accept or remove`);
  }
  need(positionals, 2, 'style id');
  const e = await engineFor(values, io);
  const json = values['json'] === true;
  switch (sub) {
    case 'validate': {
      const progress =
        io.isTTY && !json ? (s: string) => io.stderr(clean(`\rvalidate: ${s}\x1b[K`)) : undefined;
      const r = await e.styles.validate(id!, {
        ...(values['no-render'] === true ? { render: false } : {}),
        ...(values['no-dom'] === true ? { dom: false } : {}),
        ...(progress ? { onProgress: progress } : {}),
      });
      if (progress) io.stderr('\r\x1b[K');
      const where = (p: { template?: string; preset?: string; fixture?: string }) =>
        [p.template ?? p.preset, p.fixture].filter(Boolean).join(' ');
      const lines = r.problems.map(
        (p) => `FAIL ${p.rule}${where(p) ? ` ${where(p)}` : ''}: ${p.message}\n`,
      );
      for (const n of r.notes) lines.push(`note ${n}\n`);
      const checks = Object.entries(r.checked)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      lines.push(`${r.ok ? 'ok' : 'failed'}: ${r.styleId} (${checks})\n`);
      if (r.previews.length > 0) lines.push(`previews: ${r.previews.join(', ')}\n`);
      out(r, lines.join(''));
      return r.ok ? 0 : 1;
    }
    case 'new': {
      const ext = values['extends'];
      const name = values['name'];
      const r = e.styles.create({
        id: id!,
        ...(typeof ext === 'string' ? { extends: ext } : {}),
        ...(typeof name === 'string' ? { name } : {}),
      });
      out(r, `created ${r.id} (draft) at ${r.dir}\n`);
      return 0;
    }
    case 'trust': {
      const style = e.styles.get(id!);
      if (values['yes'] !== true) {
        if (json || !io.isTTY || !io.prompt) {
          throw new UsageError('style trust needs --yes when it cannot ask');
        }
        const answer = await io.prompt(
          clean(
            `Trust ${style.id} (${style.dir})? Its build.mjs runs on this computer with your permissions. [y/N] `,
          ),
        );
        if (!/^y(es)?$/i.test(answer.trim())) {
          out({ trusted: false }, 'not trusted\n');
          return 1;
        }
      }
      e.styles.trust(style.id);
      out({ id: style.id, trusted: true }, `trusted ${style.id}\n`);
      return 0;
    }
    case 'accept':
      e.styles.accept(id!);
      out({ id, status: 'active' }, `${id} is active\n`);
      return 0;
    default:
      e.styles.remove(id!);
      out({ id, removed: true }, `removed ${id}\n`);
      return 0;
  }
}

export async function run(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    io.stdout(`vox ${version}\n`);
    return 0;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    io.stderr(USAGE);
    return 2;
  }
  const json = rest.includes('--json');
  try {
    if (!Object.hasOwn(OPTIONS, cmd))
      throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
    return await command(cmd, rest, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`vox: ${e.message}\n${USAGE}`);
      return 2;
    }
    if (isVoxError(e)) {
      if (json) io.stdout(`${JSON.stringify({ error: toVoxErrorJson(e) }, null, 2)}\n`);
      else io.stderr(clean(`error: ${e.message}\nhint: ${e.hint}\n`));
      return 1;
    }
    throw e;
  }
}
