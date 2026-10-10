// yt-dlp helpers: updates (`yt-dlp -U`, yt-dlp verifies its own release checksums) and the
// `--impersonate` support check that `vox doctor` reports (TikTok pages can need it, D-13).

import { SetupError } from './errors.ts';
import { runCommand, tail } from './run.ts';

interface Base {
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export async function ytDlpVersion(bin: string, opts: Base): Promise<string> {
  const r = await runCommand(bin, ['--version'], { ...opts, timeoutMs: 30_000 });
  if (r.code !== 0)
    throw new SetupError('COMMAND_FAILED', `yt-dlp --version failed: ${tail(r.stderr)}`);
  return r.stdout.trim().split('\n').pop() ?? '';
}

export async function updateYtDlp(
  bin: string,
  opts: Base & { onOutput?: (line: string) => void },
): Promise<{ version: string }> {
  const r = await runCommand(bin, ['-U'], {
    ...opts,
    timeoutMs: 300_000,
    ...(opts.onOutput === undefined ? {} : { onLine: (l: string) => opts.onOutput?.(l) }),
  });
  if (r.code !== 0) {
    throw new SetupError(
      'COMMAND_FAILED',
      `yt-dlp -U failed (exit ${String(r.code)}): ${tail(r.stderr || r.stdout)}`,
    );
  }
  return { version: await ytDlpVersion(bin, opts) };
}

/**
 * Parses `yt-dlp --list-impersonate-targets`. Rows after the dashed rule are
 * `Client  OS  Source`; a row ending in `(unavailable)` has no backend installed.
 */
export function parseImpersonateTargets(output: string): string[] {
  const lines = output.split('\n');
  const rule = lines.findIndex((l) => /^-{5,}\s*$/.test(l));
  if (rule < 0) return [];
  const targets: string[] = [];
  for (const line of lines.slice(rule + 1)) {
    if (line.trim() === '' || line.includes('(unavailable)')) continue;
    const client = line.trim().split(/\s+/)[0];
    if (client !== undefined) targets.push(client.toLowerCase());
  }
  return targets;
}

export interface ImpersonationCheck {
  supported: boolean;
  targets: string[];
  reason?: string;
}

export async function checkImpersonation(bin: string, opts: Base): Promise<ImpersonationCheck> {
  let r;
  try {
    r = await runCommand(bin, ['--list-impersonate-targets'], { ...opts, timeoutMs: 30_000 });
  } catch (e) {
    if (opts.signal.aborted) throw e;
    return { supported: false, targets: [], reason: 'yt-dlp could not run or was not found' };
  }
  const targets = parseImpersonateTargets(r.stdout);
  if (targets.length > 0) return { supported: true, targets };
  return {
    supported: false,
    targets,
    reason:
      'no impersonation target is available (curl_cffi is missing); update yt-dlp to the official macOS build',
  };
}
