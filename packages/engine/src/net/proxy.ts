// Local filtering proxy for yt-dlp (engine spec "Ingest hardening"; R4 S3).
// yt-dlp does its own DNS and follows redirects, so every connection it makes goes through this
// proxy (`--proxy http://127.0.0.1:<port>`). For each CONNECT tunnel and each absolute-form HTTP
// request the proxy resolves the host itself, refuses non-public addresses and connects to the
// address it checked (no DNS-rebinding window). Redirects arrive as new requests and are checked
// the same way.

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { isVoxError } from '../errors.pending.ts';
import { normaliseHost, resolvePublic, systemResolver } from './address.ts';
import type { Resolver } from './address.ts';

/** Maps the checked address to the socket target. Identity in production; tests map a TEST-NET
 * address to a local server so no internet is needed. Always receives an already-checked address. */
export type Dial = (address: string, port: number) => { host: string; port: number };

export interface ProxyRefusal {
  host: string;
  port: number;
  /** `NET_BLOCKED`, `NET_DNS`, `URL_INVALID` or `UPSTREAM` (connect failed after the check). */
  code: string;
  address?: string;
}

export interface FilteringProxyOptions {
  resolver?: Resolver;
  dial?: Dial;
  /** Called for every refused or failed target, so ingest can explain a yt-dlp failure. */
  onRefused?: (refusal: ProxyRefusal) => void;
  connectTimeoutMs?: number;
  /** An open tunnel or request with no traffic for this long is closed (default 120 s). */
  idleTimeoutMs?: number;
  /** Cap on simultaneous client connections (default 256). */
  maxConnections?: number;
}

export interface FilteringProxy {
  /** `http://127.0.0.1:<port>`, the value for yt-dlp's `--proxy`. */
  url: string;
  port: number;
  /** Stops listening and destroys every open tunnel and request. */
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Parses a CONNECT authority `host:port` / `[v6]:port`; undefined when malformed. */
function parseAuthority(authority: string | undefined): { host: string; port: number } | undefined {
  if (authority === undefined) return undefined;
  const m = /^(\[[^\]\s]+\]|[^\s:[\]/@]+):(\d{1,5})$/.exec(authority);
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host: normaliseHost(m[1]), port };
}

function refuseSocket(socket: Duplex, status: number, reason: string, code?: string): void {
  if (socket.destroyed) return;
  const extra = code === undefined ? '' : `X-Vox-Refused: ${code}\r\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

function codeOf(e: unknown): string {
  return isVoxError(e) ? e.code : 'NET_DNS';
}

function statusFor(code: string): [number, string] {
  if (code === 'NET_BLOCKED') return [403, 'Forbidden'];
  if (code === 'URL_INVALID') return [400, 'Bad Request'];
  return [502, 'Bad Gateway'];
}

/** Starts the proxy on 127.0.0.1 with an OS-chosen port. */
export async function startFilteringProxy(
  opts: FilteringProxyOptions = {},
): Promise<FilteringProxy> {
  const resolver = opts.resolver ?? systemResolver;
  const dial: Dial = opts.dial ?? ((host, port) => ({ host, port }));
  const timeoutMs = opts.connectTimeoutMs ?? 30_000;
  const idleMs = opts.idleTimeoutMs ?? 120_000;
  const report = (r: ProxyRefusal): void => opts.onRefused?.(r);
  const open = new Set<Duplex>();
  const track = (s: Duplex): void => {
    open.add(s);
    s.once('close', () => open.delete(s));
  };

  const server = createServer();
  server.maxConnections = opts.maxConnections ?? 256;

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const target = parseAuthority(req.url);
    if (target === undefined) {
      report({ host: String(req.url ?? ''), port: 0, code: 'URL_INVALID' });
      refuseSocket(client, 400, 'Bad Request', 'URL_INVALID');
      return;
    }
    void (async () => {
      let address: string;
      try {
        address = await resolvePublic(target.host, resolver);
      } catch (e) {
        const code = codeOf(e);
        report({ ...target, code });
        refuseSocket(client, ...statusFor(code), code);
        return;
      }
      if (client.destroyed) return;
      const to = dial(address, target.port);
      const upstream: Socket = netConnect({ host: to.host, port: to.port });
      track(upstream);
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('connect timeout')));
      let established = false;
      upstream.once('connect', () => {
        established = true;
        upstream.setTimeout(idleMs, () => upstream.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => {
        if (established) {
          // inside an open tunnel the client speaks TLS: never write a plaintext status into it
          client.destroy();
          return;
        }
        report({ ...target, address, code: 'UPSTREAM' });
        refuseSocket(client, 502, 'Bad Gateway', 'UPSTREAM');
      });
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    })();
  });

  server.on('request', (req: IncomingMessage, res) => {
    const reply = (status: number, reason: string, code: string): void => {
      res.writeHead(status, reason, {
        'x-vox-refused': code,
        'content-length': 0,
        connection: 'close',
      });
      res.end();
    };
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      reply(400, 'Bad Request', 'URL_INVALID');
      return;
    }
    // Only plain http in absolute form; https goes through CONNECT.
    if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') {
      report({ host: url.hostname, port: Number(url.port || 0), code: 'URL_INVALID' });
      reply(400, 'Bad Request', 'URL_INVALID');
      return;
    }
    const port = url.port === '' ? 80 : Number(url.port);
    const host = normaliseHost(url.hostname);
    void (async () => {
      let address: string;
      try {
        address = await resolvePublic(host, resolver);
      } catch (e) {
        const code = codeOf(e);
        report({ host, port, code });
        reply(...statusFor(code), code);
        return;
      }
      const to = dial(address, port);
      const headers = stripHopByHop(req.headers);
      headers.host = url.host;
      const upstream = httpRequest({
        host: to.host,
        port: to.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        timeout: idleMs,
      });
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('response', (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, stripHopByHop(up.headers));
        up.pipe(res);
        res.on('close', () => up.destroy());
      });
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      upstream.on('error', () => {
        report({ host, port, address, code: 'UPSTREAM' });
        if (!res.headersSent) reply(502, 'Bad Gateway', 'UPSTREAM');
        else res.destroy();
      });
      req.pipe(upstream);
    })();
  });

  server.on('clientError', (_err, socket: Duplex) => refuseSocket(socket, 400, 'Bad Request'));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
