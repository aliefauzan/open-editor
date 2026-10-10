// Local test servers for the net tests (S3, S29). No internet: "public" hosts resolve through a fake
// resolver to a TEST-NET address, and the proxy's `dial` seam maps that address to a local server.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

/** TEST-NET-2 address the fake resolver hands out for "public" names (RFC 5737, not blocked). */
export const PUBLIC_IP = '198.51.100.7';
export const PUBLIC_HOST = 'public.test';

export interface Cert {
  cert: string;
  key: string;
}

/** Self-signed cert for `public.test`, made with openssl into a temp folder (SAN via a config file). */
export function makeCert(): Cert {
  const dir = mkdtempSync(join(tmpdir(), 'vox-net-cert-'));
  try {
    const cnf = join(dir, 'req.cnf');
    writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = ext',
        'prompt = no',
        '[dn]',
        `CN = ${PUBLIC_HOST}`,
        '[ext]',
        `subjectAltName = DNS:${PUBLIC_HOST}`,
        'basicConstraints = critical,CA:TRUE',
        '',
      ].join('\n'),
    );
    const keyPath = join(dir, 'k.pem');
    const certPath = join(dir, 'c.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-config',
        cnf,
      ],
      { stdio: 'ignore' },
    );
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface TestServer {
  port: number;
  /** TCP connections accepted so far (a refused target must stay at 0). */
  connections: number;
  /** Requests seen: `Host` header + path. */
  requests: { host: string | undefined; path: string | undefined }[];
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(server: Server, handler: Handler): Promise<TestServer> {
  const state: TestServer = {
    port: 0,
    connections: 0,
    requests: [],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  server.on('connection', () => {
    state.connections += 1;
  });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    state.requests.push({ host: req.headers.host, path: req.url });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  return state;
}

export function httpServer(handler: Handler): Promise<TestServer> {
  return listen(createHttpServer(), handler);
}

export function httpsServer(cert: Cert, handler: Handler): Promise<TestServer> {
  return listen(createHttpsServer({ cert: cert.cert, key: cert.key }), handler);
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, {
      'content-type': 'text/plain',
      'content-length': Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  };
}

export interface RawResponse {
  status: number;
  headers: string;
  body: string;
}

/** Sends `CONNECT authority` to the proxy; resolves with the status line code and the open socket. */
export function connectVia(
  proxyPort: number,
  authority: string,
): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, '127.0.0.1');
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0);
      resolve({ status, socket });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('close', () => {
      if (!buf.includes('\r\n\r\n')) resolve({ status: 0, socket });
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

/** Reads one HTTP/1.1 response (Connection: close) from a raw or TLS socket. */
function readResponse(socket: Socket): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let buf = '';
    socket.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const end = buf.indexOf('\r\n\r\n');
      const head = end === -1 ? buf : buf.slice(0, end);
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0),
        headers: head,
        body: end === -1 ? '' : buf.slice(end + 4),
      });
    });
  });
}

/** CONNECT through the proxy, then TLS to `host` (SNI + cert check) and `GET path`. */
export async function httpsGetVia(
  proxyPort: number,
  host: string,
  port: number,
  path: string,
  ca: string,
): Promise<RawResponse | { status: number; refused: true }> {
  const { status, socket } = await connectVia(proxyPort, `${host}:${port}`);
  if (status !== 200) {
    socket.destroy();
    return { status, refused: true };
  }
  const tls = tlsConnect({ socket, servername: host, ca });
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', () => resolve());
    tls.once('error', reject);
  });
  tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  return readResponse(tls);
}

/** Plain-HTTP proxy request in absolute form (`GET http://host/path`). */
export async function httpGetVia(proxyPort: number, url: string): Promise<RawResponse> {
  const socket = netConnect(proxyPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const host = new URL(url).host;
  socket.write(`GET ${url} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  return readResponse(socket);
}

/** Raw request line through the proxy (for malformed or origin-form requests). */
export async function rawVia(proxyPort: number, requestLine: string): Promise<RawResponse> {
  const socket = netConnect(proxyPort, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`);
  return readResponse(socket);
}

export function locationOf(res: RawResponse): string | undefined {
  return /\r\nlocation: ([^\r\n]+)/i.exec(res.headers)?.[1];
}
