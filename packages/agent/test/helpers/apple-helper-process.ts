// Test-only driver for a JSON-lines Apple helper (the fake `fake-apple-llm.mjs` or the real
// `vox-apple-llm`). Spawns with an argument array and no shell (S26).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

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

/** Runs the helper to completion (e.g. with `--status`) and collects its output. */
export function runOnce(cmd: Command, extraArgs: string[], stdin = ''): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.command, [...cmd.args, ...extraArgs], {
      env: { ...process.env, ...cmd.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

export interface Session {
  send(line: string): void;
  /** Next stdout line, or `null` if none arrives within `timeoutMs` or stdout closes. */
  nextLine(timeoutMs: number): Promise<string | null>;
  endInput(): void;
  kill(): void;
  exited: Promise<Exit>;
  isRunning(): boolean;
}

/** Starts a long-lived helper process for request/response exchanges. */
export function startSession(cmd: Command): Session {
  const child = spawn(cmd.command, cmd.args, {
    env: { ...process.env, ...cmd.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let running = true;
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;

  createInterface({ input: child.stdout }).on('line', (line) => {
    stdout += line + '\n';
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  child.stdin.on('error', () => {
    /* the helper may exit before reading everything (crash tests) */
  });

  const exited = new Promise<Exit>((resolve) => {
    child.on('close', (code, signal) => {
      running = false;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter(null);
      resolve({ code, signal, stdout, stderr });
    });
  });

  return {
    send: (line) => {
      child.stdin.write(line.endsWith('\n') ? line : line + '\n');
    },
    nextLine: (timeoutMs) => {
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      if (closed) return Promise.resolve(null);
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
