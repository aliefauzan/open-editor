// S29 core: engine downloads (archive fetch, images; wired in phase 05) use the in-process
// private-address check, including after every redirect, and connect to the IP they checked.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fetchPublic, readBody } from '../../src/net/fetch.ts';
import type { FetchPublicOptions } from '../../src/net/fetch.ts';
import type { Resolver } from '../../src/net/address.ts';
import { VoxError } from '../../src/errors.pending.ts';
import { PUBLIC_HOST, PUBLIC_IP, httpServer, httpsServer, makeCert, text } from './servers.ts';
import type { Cert, TestServer } from './servers.ts';

let cert: Cert;
let tlsPublic: TestServer;
let httpPublic: TestServer;
let privateTarget: TestServer;
let opts: FetchPublicOptions;
const lookups: string[] = [];

beforeAll(async () => {
  cert = makeCert();
  privateTarget = await httpServer(text('internal'));
  tlsPublic = await httpsServer(cert, (req, res) => {
    const redirects: Record<string, string> = {
      '/to-private-ip': `http://127.0.0.1:${privateTarget.port}/`,
      '/to-private-name': `http://evil.test:${privateTarget.port}/`,
      '/to-metadata': 'http://169.254.169.254/latest/meta-data/',
      '/to-public-http': `http://${PUBLIC_HOST}/plain`,
      '/relative': '/ok',
      '/to-ftp': 'ftp://public.test/x',
      '/loop': '/loop',
      '/to-other-origin': `http://${PUBLIC_HOST}/echo`,
      '/to-same-origin': '/echo',
      '/malformed': 'http://[bad',
    };
    if (req.url === '/echo') {
      text(`auth=${req.headers.authorization ?? '-'} cookie=${req.headers.cookie ?? '-'}`)(
        req,
        res,
      );
      return;
    }
    const loc = req.url === undefined ? undefined : redirects[req.url];
    if (loc !== undefined) {
      res.writeHead(302, { location: loc });
      res.end();
      return;
    }
    text(`tls ${req.url ?? ''} ${req.headers.host ?? ''}`)(req, res);
  });
  httpPublic = await httpServer((req, res) => {
    if (req.url === '/echo') {
      text(`auth=${req.headers.authorization ?? '-'} cookie=${req.headers.cookie ?? '-'}`)(
        req,
        res,
      );
      return;
    }
    text('plain http')(req, res);
  });
  const resolver: Resolver = async (host) => {
    lookups.push(host);
    if (host === PUBLIC_HOST) return [PUBLIC_IP];
    if (host === 'evil.test') return ['127.0.0.1'];
    throw new Error(`ENOTFOUND ${host}`);
  };
  opts = {
    resolver,
    ca: cert.cert,
    dial: (address, port) => {
      if (address === PUBLIC_IP && port === 443) return { host: '127.0.0.1', port: tlsPublic.port };
      if (address === PUBLIC_IP && port === 80) return { host: '127.0.0.1', port: httpPublic.port };
      return { host: address, port };
    },
  };
});

afterAll(async () => {
  await Promise.all([tlsPublic.close(), httpPublic.close(), privateTarget.close()]);
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VoxError) return e.code;
    throw e;
  }
  return 'OK';
}

describe('fetchPublic (S29)', () => {
  test('fetches a public https URL over TLS with SNI and the checked IP', async () => {
    const res = await fetchPublic(`https://${PUBLIC_HOST}/ok`, opts);
    expect(res.status).toBe(200);
    expect(res.url).toBe(`https://${PUBLIC_HOST}/ok`);
    expect((await readBody(res)).toString()).toBe(`tls /ok ${PUBLIC_HOST}`);
  });

  test('follows a relative redirect and a redirect to another public URL', async () => {
    const rel = await fetchPublic(`https://${PUBLIC_HOST}/relative`, opts);
    expect(rel.url).toBe(`https://${PUBLIC_HOST}/ok`);
    expect((await readBody(rel)).toString()).toBe(`tls /ok ${PUBLIC_HOST}`);
    const other = await fetchPublic(`https://${PUBLIC_HOST}/to-public-http`, opts);
    expect(other.url).toBe(`http://${PUBLIC_HOST}/plain`);
    expect((await readBody(other)).toString()).toBe('plain http');
  });

  test('refuses a URL whose name resolves to a private address; nothing is contacted', async () => {
    const before = privateTarget.connections;
    expect(await codeOf(fetchPublic(`http://evil.test:${privateTarget.port}/`, opts))).toBe(
      'NET_BLOCKED',
    );
    expect(await codeOf(fetchPublic(`http://127.0.0.1:${privateTarget.port}/`, opts))).toBe(
      'NET_BLOCKED',
    );
    expect(privateTarget.connections).toBe(before);
  });

  test('refuses a redirect to a private IP, a private name or the metadata address', async () => {
    const before = privateTarget.connections;
    for (const path of ['/to-private-ip', '/to-private-name', '/to-metadata']) {
      expect(await codeOf(fetchPublic(`https://${PUBLIC_HOST}${path}`, opts)), path).toBe(
        'NET_BLOCKED',
      );
    }
    expect(privateTarget.connections).toBe(before);
  });

  test('resolves each hop once', async () => {
    const start = lookups.length;
    await readBody(await fetchPublic(`https://${PUBLIC_HOST}/relative`, opts));
    expect(lookups.slice(start)).toEqual([PUBLIC_HOST, PUBLIC_HOST]);
  });

  test('only http(s): other schemes and redirects to them are URL_INVALID', async () => {
    expect(await codeOf(fetchPublic('ftp://public.test/x', opts))).toBe('URL_INVALID');
    expect(await codeOf(fetchPublic('file:///etc/passwd', opts))).toBe('URL_INVALID');
    expect(await codeOf(fetchPublic('not a url', opts))).toBe('URL_INVALID');
    expect(await codeOf(fetchPublic(`https://${PUBLIC_HOST}/to-ftp`, opts))).toBe('URL_INVALID');
  });

  test('a redirect loop stops with NET_REDIRECTS', async () => {
    expect(await codeOf(fetchPublic(`https://${PUBLIC_HOST}/loop`, opts))).toBe('NET_REDIRECTS');
  });

  test('a TLS certificate for another name is rejected', async () => {
    const wrong: FetchPublicOptions = {
      ...opts,
      resolver: async () => [PUBLIC_IP],
    };
    await expect(fetchPublic('https://other.test/ok', wrong)).rejects.toThrow();
  });

  test('credentials are kept on the same origin and dropped on another origin', async () => {
    const headers = { Authorization: 'Bearer x', Cookie: 'a=b', 'User-Agent': 'VoxStudio/test' };
    const same = await fetchPublic(`https://${PUBLIC_HOST}/to-same-origin`, { ...opts, headers });
    expect((await readBody(same)).toString()).toBe('auth=Bearer x cookie=a=b');
    const other = await fetchPublic(`https://${PUBLIC_HOST}/to-other-origin`, { ...opts, headers });
    expect(other.url).toBe(`http://${PUBLIC_HOST}/echo`);
    expect((await readBody(other)).toString()).toBe('auth=- cookie=-');
  });

  test('a malformed redirect is URL_INVALID', async () => {
    expect(await codeOf(fetchPublic(`https://${PUBLIC_HOST}/malformed`, opts))).toBe('URL_INVALID');
  });

  test('readBody stops at maxBytes', async () => {
    const res = await fetchPublic(`https://${PUBLIC_HOST}/ok`, opts);
    expect(await codeOf(readBody(res, 4))).toBe('NET_TOO_LARGE');
  });
});
