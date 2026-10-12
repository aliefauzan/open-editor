import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isVoxError } from '../../src/errors.ts';
import { pyArgv, pyEnv, repoPyProject, runPyTool, type PyBridgeOptions } from '../../src/py.ts';
import { createRedactor, REDACTED } from '../../src/redact.ts';

const NO_TELEMETRY = {
  ORT_DISABLE_TELEMETRY: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  DO_NOT_TRACK: '1',
};

const CANARY = 'sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000';
const FAKE_UV = fileURLToPath(new URL('./fake-uv.mjs', import.meta.url));
const Echo = z.object({ echo: z.unknown() });

let dir: string;
let logFile: string;
let scratch: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

beforeEach(async () => {
  dir = await tmp('vox-py-');
  logFile = join(dir, 'uv-log.json');
  vi.stubEnv('VOX_HOME', await tmp('vox-home-'));
  vi.stubEnv('VOX_PROJECTS_DIR', await tmp('vox-projects-'));
  vi.stubEnv('VOX_TOOLS_DIR', await tmp('vox-tools-'));
  vi.stubEnv('VOX_FAKE_UV_LOG', logFile);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
  scratch = [];
});

const fake = (extra: Partial<PyBridgeOptions> = {}): PyBridgeOptions => ({
  uv: FAKE_UV,
  pyProject: '/opt/vox/py',
  ...extra,
});

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => new Error('expected a failure'),
    (e: unknown) => e,
  );
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('argv and env', () => {
  it('dev mode: uv run --frozen --project <py> python -I -m vox_py.<tool>, no uv env overrides', () => {
    expect(pyArgv('transcribe', { pyProject: '/r/py' })).toEqual([
      'run',
      '--frozen',
      '--project',
      '/r/py',
      'python',
      '-I',
      '-m',
      'vox_py.transcribe',
    ]);
    const env = pyEnv({ pyProject: '/r/py' }, {});
    expect(env['UV_PROJECT_ENVIRONMENT']).toBeUndefined();
  });

  it('with a tools dir: adds --no-sync and points the uv env, cache and Pythons into it', () => {
    const opts = { pyProject: '/app/Resources/py', toolsDir: '/tools' };
    expect(pyArgv('vad', opts)).toEqual([
      'run',
      '--frozen',
      '--no-sync',
      '--project',
      '/app/Resources/py',
      'python',
      '-I',
      '-m',
      'vox_py.vad',
    ]);
    expect(pyEnv(opts, { PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
      ...NO_TELEMETRY,
      UV_PROJECT_ENVIRONMENT: join('/tools', 'py-env'),
      UV_CACHE_DIR: join('/tools', 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join('/tools', 'python'),
    });
  });

  it('refuses a tool name that is not a plain module name', () => {
    for (const bad of ['../x', 'a.b', 'a b', '', 'X-y', '--help']) {
      let err: unknown;
      try {
        pyArgv(bad, { pyProject: '/r/py' });
      } catch (e) {
        err = e;
      }
      expect(isVoxError(err) && err.code).toBe('VALIDATION');
    }
  });

  it("the spawned process gets exactly that argv and env, without the engine's secrets", async () => {
    vi.stubEnv('OPENROUTER_API_KEY', CANARY);
    const tools = await tmp('vox-tools-');
    await runPyTool('echo_tool', { mode: 'echo', payload: 1 }, Echo, fake({ toolsDir: tools }));
    const log = JSON.parse(await readFile(logFile, 'utf8'));
    expect(log.argv).toEqual(pyArgv('echo_tool', { pyProject: '/opt/vox/py', toolsDir: tools }));
    expect(log.argv).toContain('--frozen');
    expect(log.env).toEqual({
      ...NO_TELEMETRY,
      UV_PROJECT_ENVIRONMENT: join(tools, 'py-env'),
      UV_CACHE_DIR: join(tools, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(tools, 'python'),
      OPENROUTER_API_KEY: null,
    });
  });

  it('pyEnv always switches off library telemetry (onnxruntime uploads to Microsoft and can abort at exit)', () => {
    for (const opts of [{}, { pyProject: '/r/py', toolsDir: '/tools' }]) {
      const env = pyEnv(opts, { ORT_DISABLE_TELEMETRY: '0', HF_HUB_DISABLE_TELEMETRY: '0' });
      expect(env['ORT_DISABLE_TELEMETRY']).toBe('1');
      expect(env['HF_HUB_DISABLE_TELEMETRY']).toBe('1');
      expect(env['DO_NOT_TRACK']).toBe('1');
    }
  });

  it('pyEnv passes only allow-listed variables', () => {
    const env = pyEnv(
      {},
      {
        PATH: '/bin',
        HOME: '/h',
        LC_ALL: 'C',
        HF_HOME: '/hf',
        AWS_SECRET_ACCESS_KEY: 'x',
        OPENAI_API_KEY: 'y',
      },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', HF_HOME: '/hf', ...NO_TELEMETRY });
  });
});

describe('request and result', () => {
  it('sends the request on stdin and validates the result with the output schema', async () => {
    const out = await runPyTool('t', { mode: 'echo', payload: { a: [1, 2] } }, Echo, fake());
    expect(out).toEqual({ echo: { a: [1, 2] } });
  });

  it('validates the request with an input schema before spawning', async () => {
    const err = await errorOf(
      runPyTool('t', { mode: 'echo', payload: 'x' }, Echo, {
        ...fake(),
        input: z.object({ mode: z.literal('echo'), payload: z.number() }),
      }),
    );
    expect(isVoxError(err) && err.code).toBe('VALIDATION');
    await expect(readFile(logFile)).rejects.toThrow(); // never spawned
  });

  it('a result that does not match the schema fails cleanly with PY_OUTPUT_INVALID', async () => {
    const err = await errorOf(runPyTool('t', { mode: 'wrong-shape' }, Echo, fake()));
    expect(isVoxError(err) && err.code).toBe('PY_OUTPUT_INVALID');
    expect(isVoxError(err) && err.details?.['tool']).toBe('t');
  });

  it('stdout that is not JSON fails with PY_OUTPUT_INVALID', async () => {
    const err = await errorOf(runPyTool('t', { mode: 'garbage' }, Echo, fake()));
    expect(isVoxError(err) && err.code).toBe('PY_OUTPUT_INVALID');
  });
});

describe('progress and stderr', () => {
  it('parses JSON-lines progress from stderr and ignores other lines', async () => {
    const seen: [number, string | undefined][] = [];
    const out = await runPyTool('t', { mode: 'progress' }, Echo, {
      ...fake(),
      onProgress: (p, m) => seen.push([p, m]),
    });
    expect(out).toEqual({ echo: 'done' });
    expect(seen).toEqual([
      [0.5, 'half'],
      [1, undefined],
    ]);
  });

  it('a failing tool gives PY_TOOL_FAILED with the last 40 stderr lines in cause, redacted', async () => {
    const r = createRedactor();
    r.addSecrets(['registered-value-xyz-123']);
    const err = await errorOf(
      runPyTool(
        't',
        { mode: 'fail', lines: 60, secret: `${CANARY} registered-value-xyz-123` },
        Echo,
        {
          ...fake(),
          redactor: r,
        },
      ),
    );
    expect(isVoxError(err) && err.code).toBe('PY_TOOL_FAILED');
    if (!isVoxError(err)) return;
    expect(err.details).toMatchObject({ tool: 't', exitCode: 3 });
    const cause = String(err.cause);
    const lines = cause.split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[0]).toMatch(/^err line 20 /);
    expect(lines[39]).toMatch(/^err line 59 /);
    expect(cause).not.toMatch(/CANARY|registered-value-xyz-123/);
    expect(cause).toContain(REDACTED);
    expect(err.hint.length).toBeGreaterThan(0);
  });

  it('a missing uv binary gives TOOL_MISSING with a hint', async () => {
    const err = await errorOf(
      runPyTool('t', { mode: 'echo' }, Echo, fake({ uv: join(dir, 'no-such-uv') })),
    );
    expect(isVoxError(err) && err.code).toBe('TOOL_MISSING');
    expect(isVoxError(err) && err.details?.['tool']).toBe('uv');
  });
});

describe('cancel', () => {
  it('an aborted signal kills uv and its child (whole process group), CANCELLED', async () => {
    const pidFile = join(dir, 'pids.json');
    const ac = new AbortController();
    const run = runPyTool('t', { mode: 'hang', pidFile }, Echo, { ...fake(), signal: ac.signal });
    let pids: { uv: number; python: number } | undefined;
    for (let i = 0; i < 200 && !pids; i++) {
      pids = await readFile(pidFile, 'utf8')
        .then((s) => JSON.parse(s) as { uv: number; python: number })
        .catch(() => undefined);
      if (!pids) await new Promise((r) => setTimeout(r, 25));
    }
    expect(pids).toBeDefined();
    expect(alive(pids!.python)).toBe(true);
    ac.abort();
    const err = await errorOf(run);
    expect(isVoxError(err) && err.code).toBe('CANCELLED');
    expect(alive(pids!.uv)).toBe(false);
    for (let i = 0; i < 100 && alive(pids!.python); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(alive(pids!.python)).toBe(false);
  });

  it('an already-aborted signal never spawns', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await errorOf(
      runPyTool('t', { mode: 'echo' }, Echo, { ...fake(), signal: ac.signal }),
    );
    expect(isVoxError(err) && err.code).toBe('CANCELLED');
    await expect(readFile(logFile)).rejects.toThrow();
  });
});

describe('real uv + python -I (test tool vox_py._echo)', () => {
  const real = (): PyBridgeOptions => ({ pyProject: repoPyProject() });

  it('round-trips a request through the real interpreter', async () => {
    const seen: number[] = [];
    const out = await runPyTool(
      '_echo',
      { payload: { word: 'héllo', n: 3 }, progressSteps: 2 },
      z.object({ echo: z.object({ word: z.string(), n: z.number() }) }),
      { ...real(), onProgress: (p) => seen.push(p) },
    );
    expect(out).toEqual({ echo: { word: 'héllo', n: 3 } });
    expect(seen).toEqual([0.5, 1]);
  }, 60_000);

  it('a Python traceback lands in cause, redacted', async () => {
    const err = await errorOf(runPyTool('_echo', { fail: `bad key ${CANARY}` }, Echo, real()));
    expect(isVoxError(err) && err.code).toBe('PY_TOOL_FAILED');
    const cause = String(isVoxError(err) ? err.cause : '');
    expect(cause).toContain('Traceback');
    expect(cause).toContain('RuntimeError');
    expect(cause).not.toContain('CANARY');
  }, 60_000);
});

describe('robustness', () => {
  it('a request that is not JSON-serialisable fails with VALIDATION and never spawns', async () => {
    const cyclic: Record<string, unknown> = { mode: 'echo' };
    cyclic['self'] = cyclic;
    const err = await errorOf(runPyTool('t', cyclic, Echo, fake()));
    expect(isVoxError(err) && err.code).toBe('VALIDATION');
    await expect(readFile(logFile)).rejects.toThrow();
  });

  it('a throwing progress listener does not break the run', async () => {
    const out = await runPyTool('t', { mode: 'progress' }, Echo, {
      ...fake(),
      onProgress: () => {
        throw new Error('listener bug');
      },
    });
    expect(out).toEqual({ echo: 'done' });
  });

  it('progress lines are not part of the stderr tail', async () => {
    const err = await errorOf(
      runPyTool('_echo', { progressSteps: 3, fail: 'boom' }, Echo, {
        pyProject: repoPyProject(),
      }),
    );
    const cause = String(isVoxError(err) ? err.cause : '');
    expect(cause).toContain('boom');
    expect(cause).not.toContain('"progress"');
  }, 60_000);
});

describe('tool error codes (D-21)', () => {
  it('the last stderr line {"error": {code}} becomes the message, a hint and details.toolCode', async () => {
    const err = await errorOf(
      runPyTool('t', { mode: 'tool-error', code: 'DOC_ENCRYPTED' }, Echo, fake()),
    );
    expect(isVoxError(err) && err.code).toBe('PY_TOOL_FAILED');
    if (!isVoxError(err)) return;
    expect(err.message).toContain('DOC_ENCRYPTED: pdf is encrypted');
    expect(err.hint).toMatch(/password/);
    expect(err.details).toMatchObject({ toolCode: 'DOC_ENCRYPTED' });
  });

  it('a TOOL_FAILED for a missing module points at the Python env (stale py-env)', async () => {
    const err = await errorOf(
      runPyTool(
        't',
        {
          mode: 'tool-error',
          code: 'TOOL_FAILED',
          message: "ModuleNotFoundError: No module named 'mflux'",
        },
        Echo,
        fake(),
      ),
    );
    if (!isVoxError(err)) throw err;
    expect(err.message).toContain("TOOL_FAILED: ModuleNotFoundError: No module named 'mflux'");
    expect(err.hint).toMatch(/Python env/);
    expect(err.hint).toMatch(/uv\.lock/);
  });
});

describe('a tool that dies without its error line', () => {
  it('names the exception line in the message and details.stderr, with a Python env hint for import errors', async () => {
    const err = await errorOf(
      runPyTool(
        't',
        {
          mode: 'crash',
          last: "ModuleNotFoundError: No module named 'vox_py.imagegen'",
          trailing: true,
        },
        Echo,
        fake(),
      ),
    );
    expect(isVoxError(err) && err.code).toBe('PY_TOOL_FAILED');
    if (!isVoxError(err)) return;
    expect(err.message).toBe(
      "Python tool t failed (exit code 1): ModuleNotFoundError: No module named 'vox_py.imagegen'",
    );
    expect(err.details).toMatchObject({
      exitCode: 1,
      stderr: "ModuleNotFoundError: No module named 'vox_py.imagegen'",
    });
    expect(err.hint).toMatch(/Python env/);
    expect(err.hint).toMatch(/open Vox Studio|Setup → Repair/);
    expect(String(err.cause)).toContain('Traceback');
  });

  it('any other last line is named too, with the generic hint', async () => {
    const err = await errorOf(
      runPyTool('t', { mode: 'crash', last: 'RuntimeError: out of memory' }, Echo, fake()),
    );
    if (!isVoxError(err)) throw err;
    expect(err.message).toMatch(/failed \(exit code 1\): RuntimeError: out of memory$/);
    expect(err.details).toMatchObject({ stderr: 'RuntimeError: out of memory' });
    expect(err.hint).toMatch(/vox doctor/);
    expect(err.hint).not.toMatch(/uv\.lock/);
  });

  it('a very long last line is cut in the message', async () => {
    const err = await errorOf(
      runPyTool('t', { mode: 'crash', last: `ValueError: ${'x'.repeat(2000)}` }, Echo, fake()),
    );
    if (!isVoxError(err)) throw err;
    expect(err.message.length).toBeLessThan(400);
    expect(String(err.details?.['stderr']).length).toBeLessThanOrEqual(301);
  });
});
