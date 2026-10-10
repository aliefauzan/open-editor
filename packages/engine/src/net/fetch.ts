// In-process checked download for engine fetches (archive assets, images; R4 S29, wired in phase 05).
// Every hop, including each redirect, is resolved once, checked with `resolvePublic`, and the socket
// connects to the checked address (TLS keeps SNI and certificate checks on the URL's host name).

import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { VoxError } from '../errors.pending.ts';
import { normaliseHost, resolvePublic, systemResolver } from './address.ts';
import type { Resolver } from './address.ts';
import type { Dial } from './proxy.ts';

export interface FetchPublicOptions {
  resolver?: Resolver;
  /** Test seam: maps the checked address to the socket target (identity in production). */
  dial?: Dial;
  /** Extra trusted CA (PEM) for tests; production uses the system roots only. */
  ca?: string;
  headers?: Record<string, string>;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchPublicResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  /** Response body stream; consume it (`readBody`, or pipe to a file). */
  body: IncomingMessage;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VoxError('URL_INVALID', `Not a valid link: ${raw}`, 'Use an http(s) link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VoxError(
      'URL_INVALID',
      `Only http(s) links are downloaded, not ${url.protocol}`,
      'Use an http(s) link.',
      { details: { url: `${url.protocol}//${url.host}` } },
    );
  }
  return url;
}

async function requestOnce(
  url: URL,
  opts: FetchPublicOptions,
  resolver: Resolver,
  dial: Dial,
): Promise<IncomingMessage> {
  const host = normaliseHost(url.hostname);
  const address = await resolvePublic(host, resolver);
  const secure = url.protocol === 'https:';
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  const to = dial(address, port);
  const headers: OutgoingHttpHeaders = {
    ...opts.headers,
    host: url.host,
    connection: 'close',
  };
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: opts.timeoutMs ?? 30_000,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      createConnection: () =>
        secure
          ? tlsConnect({
              host: to.host,
              port: to.port,
              // SNI must be a name, never an IP literal; the certificate is checked against `host`.
              ...(isIP(host) === 0 ? { servername: host } : {}),
              ...(opts.ca === undefined ? {} : { ca: opts.ca }),
            })
          : netConnect({ host: to.host, port: to.port }),
    });
    req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url.host}`)));
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET `rawUrl` with the private-address check on every hop. Follows up to `maxRedirects` (default 5)
 * redirects; throws `URL_INVALID`, `NET_BLOCKED`, `NET_DNS` or `NET_REDIRECTS`.
 */
export async function fetchPublic(
  rawUrl: string,
  opts: FetchPublicOptions = {},
): Promise<FetchPublicResult> {
  const resolver = opts.resolver ?? systemResolver;
  const dial: Dial = opts.dial ?? ((host, port) => ({ host, port }));
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = parseHttpUrl(rawUrl);
  for (let hop = 0; ; hop += 1) {
    const res = await requestOnce(url, opts, resolver, dial);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (!REDIRECTS.has(status) || location === undefined) {
      return { url: url.href, status, headers: res.headers, body: res };
    }
    res.resume();
    if (hop >= maxRedirects) {
      throw new VoxError(
        'NET_REDIRECTS',
        `Too many redirects (more than ${maxRedirects}) from ${rawUrl}.`,
        'The link redirects in a loop. Open it in a browser to check it.',
        { details: { url: url.href } },
      );
    }
    url = parseHttpUrl(new URL(location, url).href);
  }
}

/** Reads a response body into memory, failing with `NET_TOO_LARGE` beyond `maxBytes` (default 256 MiB). */
export async function readBody(
  res: FetchPublicResult,
  maxBytes = 256 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      res.body.destroy();
      throw new VoxError(
        'NET_TOO_LARGE',
        `The download from ${res.url} is larger than ${maxBytes} bytes.`,
        'Choose a smaller file.',
        { details: { url: res.url, maxBytes } },
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
