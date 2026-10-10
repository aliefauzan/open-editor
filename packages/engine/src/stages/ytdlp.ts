// Link downloads with yt-dlp (engine spec "Ingest sources", "Ingest hardening", "Error handling";
// R4 S3, S4, S33). Every connection goes through the local filtering proxy started per download;
// the cookies opt-in comes from the user's config only; login walls map to LOGIN_REQUIRED.
import { VoxError } from '../errors.ts';
import type { Resolver } from '../net/address.ts';
import { startFilteringProxy, type Dial, type ProxyRefusal } from '../net/proxy.ts';
import { withRetry } from '../net/retry.ts';
import { runTool } from './media/run.ts';
import { classifyUrl, type UrlKind } from './sources.ts';
import { buildYtdlpArgs, type CookieBrowser } from './ytdlpArgs.ts';

/** Spec text (engine "Ingest sources"). */
export const LOGIN_REQUIRED_HINT =
  "This post needs a login. Download the video yourself and drop the file here, or turn on 'Use browser cookies' in Settings.";

/** Step 14: when yt-dlp fails, the hint offers the local-file path. */
export const YTDLP_FAILED_HINT =
  'Download the video yourself and add the file instead (vox ingest <project> <path>), or update yt-dlp (yt-dlp -U) and run vox doctor.';

const RESULT_PREFIX = 'vox-result ';
const PROGRESS_PREFIX = 'vox-progress ';

/**
 * Output flags added after the spec flags: download for real while printing one JSON line per
 * finished file (engine-generated path, size and the post's item count) and plain progress lines.
 */
export const YTDLP_REPORT_ARGS: readonly string[] = [
  '--no-simulate',
  '--print',
  `after_move:${RESULT_PREFIX}%(.{filepath,id,width,height,playlist_count,n_entries,playlist_index})j`,
  '--progress',
  '--newline',
  '--progress-template',
  `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s`,
];

/** yt-dlp errors that mean a login wall, a private post or a rate limit (yt-dlp 2026.07 texts). */
const LOGIN_PATTERNS: readonly RegExp[] = [
  /--cookies-from-browser or --cookies/i,
  /use --cookies/i,
  /\blogin required\b/i,
  /\blog ?in(to)? (to|for|an account)\b/i,
  /sign in to confirm/i,
  /registered users/i,
  /redirected to the login page/i,
  /\bprivate (video|post|account)\b|\bis private\b|\baccount is private\b/i,
  /you do not have permission to view this post/i,
  /rate[- ]limit/i,
  /HTTP Error 429|Too Many Requests/i,
];

export function isLoginWall(stderr: string): boolean {
  const errors = stderr
    .split(/\r?\n/)
    .filter((l) => l.startsWith('ERROR:'))
    .join('\n');
  return LOGIN_PATTERNS.some((p) => p.test(errors));
}

/** deno is yt-dlp's default JS runtime; without it the engine passes `--js-runtimes node`. */
export function jsRuntimeFor(tools: Readonly<Record<string, string | undefined>>): 'deno' | 'node' {
  return tools['deno'] ? 'deno' : 'node';
}

const PROXY_ENV = /^(https?_proxy|all_proxy|no_proxy|ftp_proxy|socks_proxy)$/i;

/** The child env: proxy variables removed, so only `--proxy` (the filtering proxy) applies. */
export function ytdlpEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!PROXY_ENV.test(k)) env[k] = v;
  return env;
}

export interface YtdlpFile {
  filepath: string;
  id?: string;
  width?: number;
  height?: number;
}

export interface YtdlpReport {
  files: YtdlpFile[];
  /** Videos in the post or playlist (1 for a single video). */
  count: number;
}

export function parseYtdlpReport(stdout: string): YtdlpReport {
  const files: YtdlpFile[] = [];
  let count = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(RESULT_PREFIX)) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o['filepath'] !== 'string') continue;
    const num = (k: string) => (typeof o[k] === 'number' ? o[k] : undefined);
    files.push({
      filepath: o['filepath'],
      ...(typeof o['id'] === 'string' ? { id: o['id'] } : {}),
      ...(num('width') !== undefined ? { width: num('width')! } : {}),
      ...(num('height') !== undefined ? { height: num('height')! } : {}),
    });
    count = Math.max(count, num('playlist_count') ?? num('n_entries') ?? 1);
  }
  return { files, count: Math.max(count, files.length) };
}

/** Progress 0..1 from a `vox-progress <done> <total>` line. */
export function parseProgressLine(line: string): number | undefined {
  if (!line.startsWith(PROGRESS_PREFIX)) return undefined;
  const [done, total] = line.slice(PROGRESS_PREFIX.length).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(done) || !Number.isFinite(total) || !total || total <= 0) return undefined;
  return Math.min(1, Math.max(0, done! / total));
}

/** Maps a failed yt-dlp run to the error the user sees. */
export function ytdlpFailure(e: unknown, url: string, refused: readonly ProxyRefusal[]): unknown {
  if (!(e instanceof VoxError) || e.code !== 'TOOL_FAILED') return e;
  const cause = typeof e.cause === 'string' ? e.cause : '';
  const source: UrlKind = classifyUrl(url);
  const blocked = refused.find((r) => r.code === 'NET_BLOCKED');
  if (blocked) {
    return new VoxError(
      'NET_BLOCKED',
      `The link led to a blocked address (${blocked.host}).`,
      'Links may only reach public internet addresses. Add the video as a local file instead.',
      { cause, details: { source, host: blocked.host } },
    );
  }
  if (isLoginWall(cause)) {
    return new VoxError('LOGIN_REQUIRED', `The ${source} post needs a login.`, LOGIN_REQUIRED_HINT, {
      cause,
      details: { source },
    });
  }
  return new VoxError('TOOL_FAILED', `yt-dlp could not download the ${source} link.`, YTDLP_FAILED_HINT, {
    cause,
    details: { ...(e.details ?? {}), source },
  });
}

/** Retry only plain download failures; never a login wall, a blocked host or a cancel. */
export function isRetryableDownload(e: unknown): boolean {
  return e instanceof VoxError && e.code === 'TOOL_FAILED';
}

export interface DownloadOptions {
  url: string;
  outDir: string;
  outputId: string;
  playlist?: boolean;
  /** Only from `readConfig().ingest.cookiesFromBrowser` (S33). */
  cookiesFromBrowser?: CookieBrowser | null;
  tools: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  redact?: (s: string) => string;
  onProgress?: (p: number) => void;
  /** Test seams for the filtering proxy (no internet in tests). */
  net?: { resolver?: Resolver; dial?: Dial };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** Downloads one link through a fresh filtering proxy; retries plain failures 3× with backoff. */
export async function downloadWithYtdlp(o: DownloadOptions): Promise<YtdlpReport> {
  const refused: ProxyRefusal[] = [];
  const proxy = await startFilteringProxy({
    ...(o.net?.resolver ? { resolver: o.net.resolver } : {}),
    ...(o.net?.dial ? { dial: o.net.dial } : {}),
    onRefused: (r) => refused.push(r),
  });
  try {
    const spec = buildYtdlpArgs({
      url: o.url,
      proxyUrl: proxy.url,
      outDir: o.outDir,
      outputId: o.outputId,
      ...(o.playlist ? { playlist: true } : {}),
      cookiesFromBrowser: o.cookiesFromBrowser ?? null,
      jsRuntime: jsRuntimeFor(o.tools),
    });
    const cut = spec.lastIndexOf('--');
    const args = [...spec.slice(0, cut), ...YTDLP_REPORT_ARGS, ...spec.slice(cut)];
    const ytdlp = o.tools['yt-dlp'];
    let partial = '';
    const onOut = (chunk: string): void => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) {
        const p = parseProgressLine(l);
        if (p !== undefined) o.onProgress?.(p);
      }
    };
    const { stdout } = await withRetry(
      async () => {
        refused.length = 0;
        try {
          return await runTool('yt-dlp', args, {
            ...(ytdlp ? { tools: { 'yt-dlp': ytdlp } } : {}),
            env: ytdlpEnv(o.env ?? process.env),
            ...(o.signal ? { signal: o.signal } : {}),
            ...(o.redact ? { redact: o.redact } : {}),
            onStdout: onOut,
            onStderr: onOut,
          });
        } catch (e) {
          throw ytdlpFailure(e, o.url, refused);
        }
      },
      {
        retryable: isRetryableDownload,
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.sleep ? { sleep: o.sleep } : {}),
      },
    );
    const report = parseYtdlpReport(stdout);
    if (report.files.length === 0) {
      throw new VoxError('TOOL_FAILED', 'yt-dlp finished without a video file.', YTDLP_FAILED_HINT, {
        details: { source: classifyUrl(o.url) },
      });
    }
    return report;
  } finally {
    await proxy.close();
  }
}
