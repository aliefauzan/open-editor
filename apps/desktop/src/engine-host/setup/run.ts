// Child processes: argument arrays only, no shell (S26), an AbortSignal on every child.

import { spawn } from 'node:child_process';
import { SetupError, abortError } from './errors.ts';

export interface RunOptions {
  signal: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called for each complete stdout/stderr line. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Kill the child after this long. */
  timeoutMs?: number;
  /** Bytes of each stream kept in the result (the tail). Default 64 KiB. */
  captureBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const keep = opts.captureBytes ?? 64 * 1024;
  const signal =
    opts.timeoutMs === undefined
      ? opts.signal
      : AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal.aborted) return reject(abortError());
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      signal,
    });
    const out = { stdout: '', stderr: '' };
    const partial = { stdout: '', stderr: '' };
    const feed = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
      const text = data.toString('utf8');
      out[stream] = (out[stream] + text).slice(-keep);
      if (opts.onLine === undefined) return;
      const lines = (partial[stream] + text).split(/\r?\n/);
      partial[stream] = lines.pop() ?? '';
      for (const l of lines) if (l !== '') opts.onLine(l, stream);
    };
    child.stdout.on('data', feed('stdout'));
    child.stderr.on('data', feed('stderr'));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') {
        reject(
          opts.signal.aborted ? err : new SetupError('COMMAND_FAILED', `${command} timed out`),
        );
      } else {
        reject(
          new SetupError('SPAWN_FAILED', `could not run ${command}: ${err.message}`, {
            cause: err,
          }),
        );
      }
    });
    child.on('close', (code) => {
      for (const s of ['stdout', 'stderr'] as const) {
        if (partial[s] !== '') opts.onLine?.(partial[s], s);
      }
      resolve({ code, stdout: out.stdout, stderr: out.stderr });
    });
  });
}

/** Last non-empty lines of a result, for error messages. */
export function tail(text: string, lines = 8): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}
