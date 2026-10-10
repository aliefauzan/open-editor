// URL policy and redirect-checked fetch for everything setup downloads (S16 context: the hash is the
// real defence, this keeps the transport sane). https only; plain http only to loopback and only when a
// test turns it on. Every redirect hop is re-checked.

import { SetupError } from './errors.ts';

export interface UrlPolicy {
  allowLoopbackHttp?: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function assertAllowedUrl(input: string | URL, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new SetupError('BAD_URL', `not a URL: ${String(input)}`, { cause });
  }
  if (url.username !== '' || url.password !== '') {
    throw new SetupError('BAD_URL', 'URLs with credentials are refused');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && policy.allowLoopbackHttp === true && LOOPBACK.has(url.hostname)) {
    return url;
  }
  throw new SetupError('BAD_URL', `refused URL scheme/host: ${url.protocol}//${url.hostname}`);
}

export interface FetchCheckedOptions extends UrlPolicy {
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  maxRedirects?: number;
}

/** GET with manual redirect handling; returns the final 2xx response or throws a SetupError. */
export async function fetchChecked(
  input: string | URL,
  opts: FetchCheckedOptions,
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const max = opts.maxRedirects ?? 5;
  let url = assertAllowedUrl(input, opts);
  for (let hop = 0; hop <= max; hop++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: opts.signal,
        ...(opts.headers === undefined ? {} : { headers: opts.headers }),
      });
    } catch (cause) {
      if (opts.signal.aborted) throw cause;
      throw new SetupError('NETWORK', `request failed: ${url.hostname}`, { cause });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      await res.body?.cancel();
      url = assertAllowedUrl(new URL(res.headers.get('location') ?? '', url), opts);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new SetupError('HTTP', `HTTP ${res.status} from ${url.hostname}${url.pathname}`);
    }
    return res;
  }
  throw new SetupError('HTTP', `too many redirects from ${String(input)}`);
}

export async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body === null) return '';
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new SetupError('HTTP', `response larger than ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
