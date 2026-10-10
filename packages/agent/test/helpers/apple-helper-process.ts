// Test-only driver for a JSON-lines Apple helper (the fake `fake-apple-llm.mjs` or the real
// `vox-apple-llm`). Spawns with an argument array and no shell (S26). Lines are split on `\n`
// only (JsonLineSplitter), never with `node:readline`.
import { spawn } from 'node:child_process';
import { JsonLineSplitter } from '../../src/providers/apple-protocol.ts';

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface Command {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The runner's environment without its own `VOX_FAKE_*` script, plus the command's variables. */
function childEnv(cmd: Command): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VOX_FAKE_')) env[key] = value;
  }
  return { ...env, ...cmd.env };
}

/**
 * Runs the helper to completion (e.g. with `--status`) and collects its output. A helper still
 * running after `timeoutMs` is killed and the promise rejects.
 */
export function runOnce(
  cmd: Command,
  extraArgs: string[],
  stdin = '',
  timeoutMs = 60_000,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.command, [...cmd.args, ...extraArgs], {
      env: childEnv(cmd),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd.command} did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.on('error', () => {
      /* the helper may exit before reading its input */
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

export interface Session {
  send(line: string): void;
  /** Next stdout line, or `null` if none arrives within `timeoutMs` or stdout closes. */
  nextLine(timeoutMs: number): Promise<string | null>;
  endInput(): void;
  kill(): void;
  /** Resolves once the process has ended; `code` is null when it never started. */
  exited: Promise<Exit>;
  isRunning(): boolean;
}

/** Starts a long-lived helper process for request/response exchanges. */
export function startSession(cmd: Command): Session {
  const child = spawn(cmd.command, cmd.args, {
    env: childEnv(cmd),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let running = true;
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  const splitter = new JsonLineSplitter();

  const deliver = (line: string) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  };
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d;
    for (const line of splitter.push(d)) deliver(line);
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  child.stdin.on('error', () => {
    /* the helper may exit before reading everything (crash tests) */
  });

  let finish: (exit: Exit) => void = () => {};
  const exited = new Promise<Exit>((resolve) => {
    finish = (exit) => {
      if (!running) return;
      running = false;
      const last = splitter.end();
      if (last !== null) deliver(last);
      for (const waiter of waiters.splice(0)) waiter(null);
      resolve(exit);
    };
  });
  child.on('error', (err) => {
    stderr += `${err.message}\n`;
    finish({ code: null, signal: null, stdout, stderr });
  });
  child.on('close', (code, signal) => finish({ code, signal, stdout, stderr }));

  return {
    send: (line) => {
      if (running) child.stdin.write(line.endsWith('\n') ? line : line + '\n');
    },
    nextLine: (timeoutMs) => {
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      if (!running) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter = (line: string | null) => {
          clearTimeout(timer);
          resolve(line);
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    endInput: () => child.stdin.end(),
    kill: () => {
      child.kill('SIGKILL');
    },
    exited,
    isRunning: () => running,
  };
}
