// Child-process runner for ffmpeg/ffprobe (R3 "External processes", R4 S26).
// Argument array only, never a shell; every run takes an AbortSignal and cancel kills the child
// (SIGTERM, then SIGKILL after a grace period). Failures keep the last 40 stderr lines in `cause`,
// passed through `redact` (phase 04 passes `engine.redactor.redact`).

import { spawn } from 'node:child_process';
import { VoxError } from '../../errors.pending.ts';

export type MediaTool = 'ffmpeg' | 'ffprobe';

export interface ToolPaths {
  /** ffmpeg binary; default `ffmpeg` from PATH (phase 04 resolves the tools folder first). */
  ffmpeg?: string;
  /** ffprobe binary; default `ffprobe` from PATH. */
  ffprobe?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  tools?: ToolPaths;
  /** Applied to the stderr tail before it goes into `VoxError.cause`. */
  redact?: (text: string) => string;
  /** stdout cap; the child is killed and the run fails above it. Default 64 MiB. */
  maxStdoutBytes?: number;
}

export interface RunResult {
  stdout: string;
  /** The last stderr bytes (at most 1 MiB), e.g. for the `ebur128` summary. */
  stderr: string;
}

export const STDERR_TAIL_LINES = 40;
const STDERR_KEEP_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2000;

const cancelled = (tool: MediaTool): VoxError =>
  new VoxError(
    'CANCELLED',
    `${tool} was cancelled.`,
    'Nothing was written; run it again when ready.',
    {
      details: { tool },
    },
  );

/** Last `n` non-empty lines of `text`. */
export function tailLines(text: string, n = STDERR_TAIL_LINES): string {
  return text
    .split(/\r?\n|\r/)
    .filter((l) => l.trim().length > 0)
    .slice(-n)
    .join('\n');
}

export function runTool(
  tool: MediaTool,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const bin = opts.tools?.[tool] ?? tool;
  const redact = opts.redact ?? ((s: string) => s);
  const maxStdout = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  if (opts.signal?.aborted) return Promise.reject(cancelled(tool));

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    let err = '';
    let aborted = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = (sig: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    };
    const onAbort = (): void => {
      aborted = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        if (!overflow) {
          overflow = true;
          kill('SIGKILL');
        }
        return;
      }
      out.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
      if (err.length > STDERR_KEEP_BYTES * 2) err = err.slice(-STDERR_KEEP_BYTES);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e;
    });
    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      const stderr = err.slice(-STDERR_KEEP_BYTES);
      if (aborted) return reject(cancelled(tool));
      if (spawnError) {
        if (spawnError.code === 'ENOENT') {
          return reject(
            new VoxError(
              'TOOL_MISSING',
              `${tool} was not found (${bin}).`,
              `Install ffmpeg (brew install ffmpeg), then run vox doctor.`,
              {
                details: { tool, path: bin },
              },
            ),
          );
        }
        return reject(
          new VoxError(
            'TOOL_FAILED',
            `Could not start ${tool}: ${spawnError.message}`,
            'Run vox doctor.',
            {
              cause: spawnError,
              details: { tool, errno: spawnError.code },
            },
          ),
        );
      }
      const tail = tailLines(stderr);
      const cause = tail.length > 0 ? redact(tail) : undefined;
      if (overflow) {
        return reject(
          new VoxError(
            'TOOL_FAILED',
            `${tool} wrote more than ${maxStdout} bytes.`,
            'Report this as a bug.',
            {
              cause,
              details: { tool },
            },
          ),
        );
      }
      if (code !== 0) {
        return reject(
          new VoxError(
            'TOOL_FAILED',
            `${tool} failed (${signal ? `signal ${signal}` : `exit code ${String(code)}`}).`,
            'The file may be damaged or in a format ffmpeg cannot read; try another file or run vox doctor.',
            { cause, details: { tool, exitCode: code, signal } },
          ),
        );
      }
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr });
    });
  });
}
