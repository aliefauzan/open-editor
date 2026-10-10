// yt-dlp argument list (engine spec "Ingest hardening", "Ingest sources"; R4 S4, S33; R3).
// Pure: the caller (phase 04 ingest) supplies the running filtering proxy's URL, an engine-generated
// output id, and `cookiesFromBrowser` read from the user's config only (S33).

import { isAbsolute, join } from 'node:path';
import { VoxError } from '../errors.pending.ts';
import { classifyUrl } from './sources.ts';

export const COOKIE_BROWSERS = ['safari', 'chrome', 'firefox'] as const;
export type CookieBrowser = (typeof COOKIE_BROWSERS)[number];

export interface YtdlpArgsOptions {
  /** The user's http(s) link. */
  url: string;
  /** The local filtering proxy, `http://127.0.0.1:<port>`. */
  proxyUrl: string;
  /** Absolute folder the download goes to. */
  outDir: string;
  /** Engine-generated file stem (e.g. the new media id); never derived from the remote title. */
  outputId: string;
  /** `--playlist`: take every item instead of only the first. */
  playlist?: boolean;
  /** From `ingest.cookiesFromBrowser` in the user's config only (S33). */
  cookiesFromBrowser?: CookieBrowser | null;
  /** `node` when deno is absent: adds `--js-runtimes node` (deno is yt-dlp's default). */
  jsRuntime?: 'deno' | 'node';
}

const PROXY_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
const OUTPUT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

function invalid(message: string): VoxError {
  return new VoxError('VALIDATION', message, 'This is an engine bug; please report it.');
}

export function buildYtdlpArgs(opts: YtdlpArgsOptions): string[] {
  if (classifyUrl(opts.url) === 'invalid') {
    throw new VoxError(
      'URL_INVALID',
      `Not an http(s) link: ${opts.url}`,
      'Paste an http(s) link, or add the video as a local file.',
    );
  }
  const port = Number(PROXY_URL.exec(opts.proxyUrl)?.[1] ?? 0);
  if (port < 1 || port > 65535) {
    throw invalid(`yt-dlp must use the local filtering proxy, got "${opts.proxyUrl}".`);
  }
  if (!isAbsolute(opts.outDir) || opts.outDir.includes('%')) {
    throw invalid(`yt-dlp output folder must be an absolute path without "%": "${opts.outDir}".`);
  }
  if (!OUTPUT_ID.test(opts.outputId)) {
    throw invalid(`yt-dlp output id must match ${OUTPUT_ID.source}: "${opts.outputId}".`);
  }
  const cookies = opts.cookiesFromBrowser ?? null;
  if (cookies !== null && !(COOKIE_BROWSERS as readonly string[]).includes(cookies)) {
    throw invalid(`Unknown cookies browser "${String(cookies)}".`);
  }

  const stem = opts.playlist === true ? `${opts.outputId}-%(playlist_index)s` : opts.outputId;
  return [
    '--ignore-config',
    '--no-plugin-dirs',
    ...(opts.playlist === true ? [] : ['--no-playlist', '--playlist-items', '1']),
    '--max-filesize',
    '4G',
    '-f',
    'bv*+ba/b',
    '-S',
    'res:1080',
    '--merge-output-format',
    'mp4',
    '--proxy',
    opts.proxyUrl,
    '-o',
    join(opts.outDir, `${stem}.%(ext)s`),
    ...(opts.jsRuntime === 'node' ? ['--js-runtimes', 'node'] : []),
    ...(cookies === null ? [] : ['--cookies-from-browser', cookies]),
    '--',
    opts.url,
  ];
}
