import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tmp(label = 'vox-setup'): string {
  const d = mkdtempSync(join(tmpdir(), `${label}-`));
  dirs.push(d);
  return d;
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface TestServer {
  base: string;
  hits: string[];
}

/** Local HTTP fixture server: path -> body, or a handler. Records every request path. */
export async function serve(
  routes: Record<string, Buffer | string | Handler>,
): Promise<TestServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    hits.push(path);
    const route = routes[path];
    if (route === undefined) {
      res.writeHead(404).end('not found');
    } else if (typeof route === 'function') {
      void route(req, res);
    } else {
      res.writeHead(200, { 'content-length': Buffer.byteLength(route) }).end(route);
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return { base: `http://127.0.0.1:${addr.port}`, hits };
}

export function writeScript(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Builds a .tar.gz from {name: content} using the system bsdtar. */
export function makeTarGz(files: Record<string, string>, extraArgs: string[] = []): Buffer {
  const src = tmp('tar-src');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), content);
    chmodSync(join(src, name), 0o755);
  }
  const out = join(tmp('tar-out'), 'a.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', out, ...extraArgs, '-C', src, ...Object.keys(files)]);
  return execFileSync('/bin/cat', [out], { maxBuffer: 1 << 26 });
}

export function makeZip(files: Record<string, string>): Buffer {
  const src = tmp('zip-src');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), content);
    chmodSync(join(src, name), 0o755);
  }
  const out = join(tmp('zip-out'), 'a.zip');
  execFileSync('/usr/bin/zip', ['-q', '-r', out, ...Object.keys(files)], { cwd: src });
  return execFileSync('/bin/cat', [out], { maxBuffer: 1 << 26 });
}

export const noSignal = (): AbortSignal => new AbortController().signal;
