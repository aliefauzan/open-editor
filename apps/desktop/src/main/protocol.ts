// `vox-app://` (bundled renderer files) and `vox-media://` (project builds, media, styles) handler
// parts (app spec "Window security", "Untrusted HTML"; R4 S1, S13, S28). No Electron imports here:
// main/index.ts registers the schemes and calls these. The path rule comes from @vox/engine/paths.
import { createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isProjectId, projectDirFor, resolveProjectPath } from '@vox/engine/paths';

export const CSP_APP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' vox-media: data: blob:; media-src vox-media: blob:; frame-src vox-media:; connect-src 'self'; frame-ancestors 'none'";

export const CSP_MEDIA =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'none'; frame-ancestors vox-app:";

/** Types served inline; everything else is an attachment. */
export const INLINE_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const STYLE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Fonts are fetched in CORS mode, and the opaque-sandbox player (origin `null`) is cross-origin to
 * everything, so font responses (only) allow any origin (D-XX). Every other response has no CORS
 * header, so cross-origin reads stay blocked; builds also have `connect-src 'none'`.
 */
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf']);

export interface MediaRoots {
  projectsDir: string;
  stylesDirs: readonly string[];
}

type UrlParts = { host: string; pathname: string };

function partsOf(url: string | UrlParts): UrlParts | null {
  if (typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    return { host: u.host, pathname: u.pathname };
  } catch {
    return null;
  }
}

/** The engine path rule under `root`; only existing regular files. */
async function fileUnder(root: string, rel: string): Promise<string | null> {
  if (rel === '') return null;
  try {
    const real = await resolveProjectPath(root, rel);
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * `vox-media://p/<projectId>/<rel>` → a file of that project; `vox-media://styles/<styleId>/<rel>`
 * → a file of the first styles folder that has the style. Anything else → null (404).
 */
export async function resolveMediaPath(
  url: string | UrlParts,
  roots: MediaRoots,
): Promise<string | null> {
  const p = partsOf(url);
  if (!p) return null;
  const [id = '', ...rest] = p.pathname.replace(/^\//, '').split('/');
  const rel = rest.join('/');
  if (p.host === 'p') {
    if (!isProjectId(id)) return null;
    return fileUnder(projectDirFor(roots.projectsDir, id), rel);
  }
  if (p.host === 'styles') {
    if (!STYLE_ID.test(id)) return null;
    for (const dir of roots.stylesDirs) {
      const f = await fileUnder(path.join(dir, id), rel);
      if (f) return f;
    }
  }
  return null;
}

/** `vox-app://app/<rel>` → a bundled renderer file (`/` is index.html). */
export async function resolveAppPath(url: string, rendererDir: string): Promise<string | null> {
  const p = partsOf(url);
  if (!p || p.host !== 'app') return null;
  const rel = p.pathname === '/' ? 'index.html' : p.pathname.replace(/^\//, '');
  return fileUnder(rendererDir, rel);
}

/** `Range: bytes=a-b` → inclusive [start, end], or null when absent / unsatisfiable. */
export function parseRange(header: string | null, size: number): [number, number] | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return [start, end];
}

export function headersFor(file: string, csp: string | null): Headers {
  const ext = path.extname(file).toLowerCase();
  const type = INLINE_TYPES[ext];
  const h = new Headers({ 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
  if (type) h.set('Content-Type', type);
  else {
    h.set('Content-Type', 'application/octet-stream');
    h.set('Content-Disposition', 'attachment');
  }
  if (csp && ext === '.html') h.set('Content-Security-Policy', csp);
  if (FONT_EXTS.has(ext)) h.set('Access-Control-Allow-Origin', '*');
  return h;
}

/** Serves a file with range support (206 / 416). */
export function fileResponse(file: string, req: Request, csp: string | null): Response {
  const size = statSync(file).size;
  const h = headersFor(file, csp);
  const rangeHeader = req.headers.get('Range');
  const range = parseRange(rangeHeader, size);
  if (rangeHeader && !range) {
    h.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers: h });
  }
  const [start, end] = range ?? [0, size - 1];
  h.set('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (range) h.set('Content-Range', `bytes ${start}-${end}/${size}`);
  const body =
    size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream);
  return new Response(body, { status: range ? 206 : 200, headers: h });
}

export function notFound(): Response {
  return new Response('not found', {
    status: 404,
    headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/plain' },
  });
}
