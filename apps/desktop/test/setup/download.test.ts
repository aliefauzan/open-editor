// S16: first-run downloads are pinned and SHA-256 checked; a mismatch is refused and leaves nothing behind.
import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadVerified } from '../../src/engine-host/setup/download.ts';
import { assertAllowedUrl } from '../../src/engine-host/setup/http.ts';
import { SetupError } from '../../src/engine-host/setup/errors.ts';
import { noSignal, serve, sha256, tmp } from './helpers.ts';

const body = Buffer.alloc(300_000, 7);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SetupError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

describe('downloadVerified', () => {
  test('verifies, renames into place and reports monotonic progress', async () => {
    const srv = await serve({ '/a.bin': body });
    const dir = tmp();
    const dest = join(dir, 'a.bin');
    const seen: Array<[number, number | undefined]> = [];
    const r = await downloadVerified({
      url: `${srv.base}/a.bin`,
      destPath: dest,
      sha256: sha256(body),
      size: body.length,
      signal: noSignal(),
      allowLoopbackHttp: true,
      onProgress: (got, total) => seen.push([got, total]),
    });
    expect(r).toEqual({ path: dest, sha256: sha256(body), size: body.length });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(readdirSync(dir)).toEqual(['a.bin']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual([body.length, body.length]);
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]![0]).toBeGreaterThanOrEqual(seen[i - 1]![0]);
  });

  test('hash mismatch is refused and nothing is left behind', async () => {
    const srv = await serve({ '/a.bin': body });
    const dir = tmp();
    const dest = join(dir, 'a.bin');
    const code = await codeOf(
      downloadVerified({
        url: `${srv.base}/a.bin`,
        destPath: dest,
        sha256: sha256('something else'),
        signal: noSignal(),
        allowLoopbackHttp: true,
      }),
    );
    expect(code).toBe('HASH_MISMATCH');
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a pre-existing file at destPath survives a refused download', async () => {
    const srv = await serve({ '/a.bin': body });
    const dir = tmp();
    const dest = join(dir, 'a.bin');
    await downloadVerified({
      url: `${srv.base}/a.bin`,
      destPath: dest,
      sha256: sha256(body),
      signal: noSignal(),
      allowLoopbackHttp: true,
    });
    const code = await codeOf(
      downloadVerified({
        url: `${srv.base}/a.bin`,
        destPath: dest,
        sha256: '0'.repeat(64),
        signal: noSignal(),
        allowLoopbackHttp: true,
      }),
    );
    expect(code).toBe('HASH_MISMATCH');
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  test('size mismatch is refused', async () => {
    const srv = await serve({ '/a.bin': body });
    const dir = tmp();
    const code = await codeOf(
      downloadVerified({
        url: `${srv.base}/a.bin`,
        destPath: join(dir, 'a.bin'),
        sha256: sha256(body),
        size: body.length - 1,
        signal: noSignal(),
        allowLoopbackHttp: true,
      }),
    );
    expect(code).toBe('SIZE_MISMATCH');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('HTTP errors are reported', async () => {
    const srv = await serve({});
    const dir = tmp();
    const code = await codeOf(
      downloadVerified({
        url: `${srv.base}/missing`,
        destPath: join(dir, 'x'),
        sha256: sha256(''),
        signal: noSignal(),
        allowLoopbackHttp: true,
      }),
    );
    expect(code).toBe('HTTP');
  });

  test('follows a redirect, but refuses one that leaves the allowed schemes', async () => {
    const srv = await serve({
      '/ok': (_req, res) => void res.writeHead(302, { location: '/a.bin' }).end(),
      '/evil': (_req, res) => void res.writeHead(302, { location: 'file:///etc/passwd' }).end(),
      '/a.bin': body,
    });
    const dir = tmp();
    const opts = { sha256: sha256(body), signal: noSignal(), allowLoopbackHttp: true };
    await downloadVerified({ ...opts, url: `${srv.base}/ok`, destPath: join(dir, 'ok.bin') });
    const code = await codeOf(
      downloadVerified({ ...opts, url: `${srv.base}/evil`, destPath: join(dir, 'evil.bin') }),
    );
    expect(code).toBe('BAD_URL');
  });

  test('an abort mid-stream rejects with AbortError and cleans up', async () => {
    const srv = await serve({
      '/slow': (_req, res) => {
        res.writeHead(200, { 'content-length': 1_000_000 });
        res.write(Buffer.alloc(1000));
      },
    });
    const dir = tmp();
    const ac = new AbortController();
    const p = downloadVerified({
      url: `${srv.base}/slow`,
      destPath: join(dir, 'slow.bin'),
      sha256: sha256(''),
      signal: ac.signal,
      allowLoopbackHttp: true,
      onProgress: (got) => {
        if (got > 0) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('assertAllowedUrl', () => {
  test('https is allowed; plain http only for loopback and only when enabled', () => {
    expect(assertAllowedUrl('https://github.com/x', {}).hostname).toBe('github.com');
    expect(() => assertAllowedUrl('http://github.com/x', { allowLoopbackHttp: true })).toThrow(
      SetupError,
    );
    expect(() => assertAllowedUrl('http://127.0.0.1:9/x', {})).toThrow(SetupError);
    expect(assertAllowedUrl('http://127.0.0.1:9/x', { allowLoopbackHttp: true }).port).toBe('9');
    expect(() => assertAllowedUrl('ftp://example.com/x', {})).toThrow(SetupError);
    expect(() => assertAllowedUrl('https://user:pw@example.com/x', {})).toThrow(SetupError);
    expect(() => assertAllowedUrl('not a url', {})).toThrow(SetupError);
  });
});
