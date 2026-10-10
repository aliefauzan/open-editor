// `vox` command line: a thin wrapper over the engine API (engine spec "Library API"). Every command
// takes --json and --projects-dir. A VoxError exits 1 and prints its hint (--json: the error object);
// usage errors exit 2.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  isVoxError,
  openEngine,
  resolveProjectsDir,
  toVoxErrorJson,
  version,
  VoxError,
  type Actor,
  type ApplyResult,
  type Engine,
  type HistoryEntry,
} from '@vox/engine';

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}

const defaultIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
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

function toolsDir(io: Io): string {
  return (
    io.env['VOX_TOOLS_DIR'] ??
    join(io.env['HOME'] ?? homedir(), 'Library', 'Application Support', 'Vox Studio', 'tools')
  );
}

function stylesDirs(io: Io): string[] {
  const builtIn = fileURLToPath(new URL('../../../styles', import.meta.url));
  const voxHome = io.env['VOX_HOME'] ?? join(io.env['HOME'] ?? homedir(), '.vox');
  return [builtIn, join(voxHome, 'styles')];
}

function engineFor(values: Parsed['values'], io: Io): Engine {
  const flag = values['projects-dir'];
  const { dir } = resolveProjectsDir({
    flag: typeof flag === 'string' ? flag : undefined,
    env: io.env,
    home: io.env['HOME'],
    cwd: io.cwd,
  });
  return openEngine({ projectsDir: dir, stylesDirs: stylesDirs(io), tools: { dir: toolsDir(io) } });
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
    case 'paths': {
      const e = engineFor(values, io);
      out(
        { projectsDir: e.projectsDir, stylesDirs: e.stylesDirs, tools: e.tools },
        `projects: ${e.projectsDir}\nstyles: ${e.stylesDirs.join(', ')}\ntools: ${toolsDir(io)}\n`,
      );
      return 0;
    }
    case 'new': {
      need(positionals, 1, '<name>');
      const name = positionals[0]!;
      const e = engineFor(values, io);
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
      const e = engineFor(values, io);
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
      const e = engineFor(values, io);
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
      const e = engineFor(values, io);
      const id = await resolveProject(e, positionals[0]!);
      const entries = await e.history(id, since === undefined ? {} : { sinceVersion: since });
      out(entries, entries.map(historyLine).join(''));
      return 0;
    }
    case 'snapshot': {
      need(positionals, 1, '<project>');
      const e = engineFor(values, io);
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
    default:
      throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
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
