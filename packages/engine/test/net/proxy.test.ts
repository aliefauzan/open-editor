// S3: yt-dlp connects only through the filtering proxy; the proxy refuses private, loopback,
// link-local and multicast targets and connects to the IP it checked. No internet: the fake resolver
// maps public.test to a TEST-NET address and `dial` maps that address to a local server.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFilteringProxy } from '../../src/net/proxy.ts';
import type { FilteringProxy, ProxyRefusal } from '../../src/net/proxy.ts';
import type { Resolver } from '../../src/net/address.ts';
import {
  PUBLIC_HOST,
  PUBLIC_IP,
  connectVia,
  httpGetVia,
  httpServer,
  httpsGetVia,
  httpsServer,
  locationOf,
  makeCert,
  rawVia,
  text,
} from './servers.ts';
import type { Cert, TestServer } from './servers.ts';

let cert: Cert;
let tlsPublic: TestServer; // reached only through dial(PUBLIC_IP)
let httpPublic: TestServer; // reached only through dial(PUBLIC_IP) on port 80
let privateTarget: TestServer; // a real loopback server: must never see a connection
let proxy: FilteringProxy;
const refusals: ProxyRefusal[] = [];
const dialed: string[] = [];
const lookups: string[] = [];

beforeAll(async () => {
  cert = makeCert();
  privateTarget = await httpServer(text('internal'));
  tlsPublic = await httpsServer(cert, (req, res) => {
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: `https://127.0.0.1:${privateTarget.port}/` });
      res.end();
      return;
    }
    if (req.url === '/redirect-name') {
      res.writeHead(302, { location: `https://evil.test:${privateTarget.port}/` });
      res.end();
      return;
    }
    text('hello over tls')(req, res);
  });
  httpPublic = await httpServer((req, res) => {
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: `http://127.0.0.1:${privateTarget.port}/` });
      res.end();
      return;
    }
    if (req.url === '/redirect-name') {
      res.writeHead(302, { location: `http://evil.test:${privateTarget.port}/` });
      res.end();
      return;
    }
    text(`plain ${req.headers.host ?? ''}`)(req, res);
  });
  const resolver: Resolver = async (host) => {
    lookups.push(host);
    if (host === PUBLIC_HOST) return [PUBLIC_IP];
    if (host === 'evil.test') return ['127.0.0.1'];
    if (host === 'meta.test') return ['169.254.169.254'];
    if (host === 'mcast.test') return ['224.0.0.251'];
    throw new Error(`ENOTFOUND ${host}`);
  };
  proxy = await startFilteringProxy({
    resolver,
    dial: (address, port) => {
      dialed.push(`${address}:${port}`);
      if (address === PUBLIC_IP && port === 443) return { host: '127.0.0.1', port: tlsPublic.port };
      if (address === PUBLIC_IP && port === 80) return { host: '127.0.0.1', port: httpPublic.port };
      return { host: address, port };
    },
    onRefused: (r) => refusals.push(r),
  });
});

afterAll(async () => {
  await proxy.close();
  await Promise.all([tlsPublic.close(), httpPublic.close(), privateTarget.close()]);
});

describe('filtering proxy: CONNECT (S3)', () => {
  test('listens on loopback and exposes an http proxy url', () => {
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
  });

  test('tunnels TLS to a public host, connecting to the checked IP', async () => {
    const res = await httpsGetVia(proxy.port, PUBLIC_HOST, 443, '/', cert.cert);
    expect(res.status).toBe(200);
    expect('body' in res && res.body).toBe('hello over tls');
    expect(dialed).toContain(`${PUBLIC_IP}:443`);
  });

  test('refuses a private IP literal target; the target never sees a connection', async () => {
    const before = privateTarget.connections;
    const { status, socket } = await connectVia(proxy.port, `127.0.0.1:${privateTarget.port}`);
    socket.destroy();
    expect(status).toBe(403);
    for (const authority of ['10.0.0.1:443', '[::1]:443', '169.254.169.254:80', '[fe80::1]:443']) {
      const r = await connectVia(proxy.port, authority);
      r.socket.destroy();
      expect(r.status, authority).toBe(403);
    }
    expect(privateTarget.connections).toBe(before);
  });

  test('refuses a DNS name resolving to 127.0.0.1', async () => {
    const before = privateTarget.connections;
    const { status, socket } = await connectVia(proxy.port, `evil.test:${privateTarget.port}`);
    socket.destroy();
    expect(status).toBe(403);
    expect(privateTarget.connections).toBe(before);
    expect(refusals.some((r) => r.host === 'evil.test' && r.code === 'NET_BLOCKED')).toBe(true);
  });

  test('refuses link-local and multicast names', async () => {
    for (const host of ['meta.test', 'mcast.test']) {
      const r = await connectVia(proxy.port, `${host}:443`);
      r.socket.destroy();
      expect(r.status, host).toBe(403);
    }
  });

  test('a redirect to a private IP is refused on the next CONNECT', async () => {
    const first = await httpsGetVia(proxy.port, PUBLIC_HOST, 443, '/redirect-private', cert.cert);
    expect(first.status).toBe(302);
    const loc = new URL(locationOf(first as never) ?? '');
    const before = privateTarget.connections;
    const second = await connectVia(proxy.port, loc.host);
    second.socket.destroy();
    expect(second.status).toBe(403);
    expect(privateTarget.connections).toBe(before);
  });

  test('a redirect to a name resolving to loopback is refused on the next CONNECT', async () => {
    const first = await httpsGetVia(proxy.port, PUBLIC_HOST, 443, '/redirect-name', cert.cert);
    expect(first.status).toBe(302);
    const loc = new URL(locationOf(first as never) ?? '');
    const second = await connectVia(proxy.port, loc.host);
    second.socket.destroy();
    expect(second.status).toBe(403);
  });

  test('resolves each CONNECT host once (no DNS-rebinding window)', async () => {
    const start = lookups.length;
    const res = await httpsGetVia(proxy.port, PUBLIC_HOST, 443, '/', cert.cert);
    expect(res.status).toBe(200);
    expect(lookups.slice(start)).toEqual([PUBLIC_HOST]);
  });

  test('an unknown name or a malformed authority is refused', async () => {
    for (const [authority, code] of [
      ['nowhere.test:443', 502],
      ['public.test', 400],
      ['public.test:0', 400],
      ['public.test:70000', 400],
      ['[::1:443', 400],
    ] as const) {
      const r = await connectVia(proxy.port, authority);
      r.socket.destroy();
      expect(r.status, authority).toBe(code);
    }
  });
});

describe('filtering proxy: plain HTTP (S3)', () => {
  test('forwards an absolute-form request to a public host with its Host header', async () => {
    const res = await httpGetVia(proxy.port, `http://${PUBLIC_HOST}/x`);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`plain ${PUBLIC_HOST}`);
  });

  test('refuses a private IP literal and a name resolving to loopback', async () => {
    const before = privateTarget.connections;
    expect((await httpGetVia(proxy.port, `http://127.0.0.1:${privateTarget.port}/`)).status).toBe(
      403,
    );
    expect((await httpGetVia(proxy.port, `http://evil.test:${privateTarget.port}/`)).status).toBe(
      403,
    );
    expect(privateTarget.connections).toBe(before);
  });

  test('a redirect to a private IP is refused when the client follows it', async () => {
    for (const path of ['/redirect-private', '/redirect-name']) {
      const first = await httpGetVia(proxy.port, `http://${PUBLIC_HOST}${path}`);
      expect(first.status).toBe(302);
      const before = privateTarget.connections;
      const second = await httpGetVia(proxy.port, locationOf(first) ?? '');
      expect(second.status, path).toBe(403);
      expect(privateTarget.connections).toBe(before);
    }
  });

  test('origin-form and non-http requests are refused', async () => {
    expect((await rawVia(proxy.port, 'GET / HTTP/1.1')).status).toBe(400);
    expect((await rawVia(proxy.port, 'GET ftp://public.test/x HTTP/1.1')).status).toBe(400);
    expect((await rawVia(proxy.port, 'GET https://public.test/x HTTP/1.1')).status).toBe(400);
  });
});

describe('filtering proxy: lifecycle', () => {
  test('close() ends open tunnels', async () => {
    const p = await startFilteringProxy({
      resolver: async () => [PUBLIC_IP],
      dial: () => ({ host: '127.0.0.1', port: tlsPublic.port }),
    });
    const { status, socket } = await connectVia(p.port, `${PUBLIC_HOST}:443`);
    expect(status).toBe(200);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await p.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});
