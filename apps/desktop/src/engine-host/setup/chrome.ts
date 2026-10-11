// Chrome for HyperFrames rendering (app spec "First-run setup"): HyperFrames' own browser install,
// run with the bundled pinned CLI and the app's Electron as Node (no system Node). Ready means the
// managed chrome-headless-shell (the optimized capture path GATE 1 measured); a system Chrome that
// HyperFrames would fall back to does not count, the same rule as `vox doctor`.
import { basename } from 'node:path';
import { SetupError } from './errors.ts';
import { runCommand, tail } from './run.ts';
import type { Delegate } from './setup.ts';
import { progress } from './types.ts';

export interface ChromeDelegateOptions {
  /** Node to run the CLI with: the app's Electron (`ELECTRON_RUN_AS_NODE=1` in `env`). */
  node: string;
  /** `hyperframes/bin/hyperframes.mjs` of the pinned package. */
  cli: string;
  env: NodeJS.ProcessEnv;
}

const QUIET = { HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' };
const MANAGED = new Set(['chrome-headless-shell', 'chrome-headless-shell.exe']);

export function chromeDelegate(o: ChromeDelegateOptions): Delegate {
  const env = { ...o.env, ...QUIET };
  return {
    async check(signal) {
      const r = await runCommand(o.node, [o.cli, 'browser', 'path'], {
        signal,
        env,
        timeoutMs: 60_000,
      });
      const path = r.stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('/'));
      return r.code === 0 && path !== undefined && MANAGED.has(basename(path));
    },
    async install(signal, onProgress) {
      progress(onProgress, 'chrome', 'download', { message: 'hyperframes browser ensure --force' });
      const r = await runCommand(o.node, [o.cli, 'browser', 'ensure', '--force'], {
        signal,
        env,
        timeoutMs: 1_800_000,
        onLine: (line) => {
          if (line.trim() !== '') progress(onProgress, 'chrome', 'download', { message: line });
        },
      });
      if (r.code !== 0) {
        throw new SetupError(
          'COMMAND_FAILED',
          `hyperframes browser ensure failed (exit ${String(r.code)}): ${tail(r.stderr || r.stdout)}`,
        );
      }
    },
  };
}
