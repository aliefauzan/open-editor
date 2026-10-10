/** Child processes with an argument array (S26: no shell). */
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  ms: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called with each child pid right after spawn (for RSS sampling). */
  onSpawn?: (pid: number) => void;
  /** Echo stderr lines to our stderr. */
  echo?: boolean;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      err += s;
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
      if (opts.echo) process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: err,
        ms: performance.now() - t0,
      }),
    );
  });
}

/** Like `run`, but throws with the stderr tail when the exit code is not 0. */
export async function runOk(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0)
    throw new Error(
      `${cmd} ${args.slice(0, 6).join(' ')} … exited ${r.code}\n${r.stderr.slice(-3000)}`,
    );
  return r;
}

/** Environment for every HyperFrames CLI call: no telemetry. */
export function hfEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' };
}
