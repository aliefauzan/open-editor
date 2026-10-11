/**
 * `vox-app://` and `vox-media://` handlers for the spike window (app spec "Window security",
 * "Untrusted HTML"). Pure helpers are exported for unit tests; `fileResponse` serves a file with
 * range support.
 */
import { createReadStream, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const CSP_APP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' vox-media: data: blob:; media-src vox-media: blob:; frame-src vox-media:; connect-src 'self'; frame-ancestors 'none'";

export const CSP_MEDIA =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'none'; frame-ancestors vox-app:";

/** Types served inline; everything else is an attachment. */
export const INLINE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Engine path rule: decode once, reject NUL / absolute / `..`, realpath, prefix check with a
 * trailing separator. Returns the real file path or null.
 */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relPath = decoded.replace(/^\/+/, '');
  if (!relPath || path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) return null;
  if (relPath.split(/[\\/]/).includes('..')) return null;
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(path.join(realRoot, relPath));
  } catch {
    return null;
  }
  return real.startsWith(realRoot + path.sep) ? real : null;
}

/** `Range: bytes=a-b` → inclusive [start, end], or null when absent / unsatisfiable. */
export function parseRange(header: string | null, size: number): [number, number] | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
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
  return h;
}

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
  h.set('Content-Length', String(end - start + 1));
  if (range) h.set('Content-Range', `bytes ${start}-${end}/${size}`);
  const body =
    size === 0 ? null : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream);
  return new Response(body, { status: range ? 206 : 200, headers: h });
}

/** In-memory file (a compiled build that was not written yet). */
export function textResponse(name: string, content: string, csp: string | null): Response {
  const h = headersFor(name, csp);
  return new Response(content, { status: 200, headers: h });
}
