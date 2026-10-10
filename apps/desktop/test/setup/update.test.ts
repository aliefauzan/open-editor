// Update check (phase 09 step 6): GitHub Releases API, newer tag -> banner data. No auto-update.
import { describe, expect, test } from 'vitest';
import { checkForUpdate } from '../../src/engine-host/setup/update.ts';
import { noSignal, serve } from './helpers.ts';
import type { Handler } from './helpers.ts';

// Shape of GET /repos/{owner}/{repo}/releases/latest (trimmed to the fields GitHub documents).
const RELEASE = {
  url: 'https://api.github.com/repos/aliefauzan/open-editor/releases/301',
  html_url: 'https://github.com/aliefauzan/open-editor/releases/tag/v0.2.0',
  id: 301,
  tag_name: 'v0.2.0',
  name: 'Vox Studio 0.2.0',
  draft: false,
  prerelease: false,
  created_at: '2026-10-20T10:00:00Z',
  published_at: '2026-10-20T10:05:00Z',
  assets: [
    {
      name: 'Vox-Studio-0.2.0-arm64.dmg',
      size: 241000000,
      browser_download_url:
        'https://github.com/aliefauzan/open-editor/releases/download/v0.2.0/Vox-Studio-0.2.0-arm64.dmg',
    },
  ],
  body: 'Adds the style gallery.',
};

const json =
  (obj: unknown, status = 200): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
  };

const REPO = 'aliefauzan/open-editor';
const path = `/repos/${REPO}/releases/latest`;

async function check(
  release: unknown,
  currentVersion: string,
  status = 200,
  repo: string | undefined = REPO,
) {
  const srv = await serve({ [path]: json(release, status) });
  const result = await checkForUpdate({
    repo,
    currentVersion,
    apiBase: srv.base,
    allowLoopbackHttp: true,
    signal: noSignal(),
  });
  return { result, srv };
}

describe('checkForUpdate', () => {
  test('newer release -> available, with the release page and dmg asset', async () => {
    const { result, srv } = await check(RELEASE, '0.1.0');
    expect(result).toEqual({
      status: 'available',
      current: '0.1.0',
      latest: '0.2.0',
      tag: 'v0.2.0',
      name: 'Vox Studio 0.2.0',
      url: RELEASE.html_url,
      publishedAt: '2026-10-20T10:05:00Z',
    });
    expect(srv.hits).toEqual([path]);
  });

  test('same or older release -> up-to-date', async () => {
    expect((await check(RELEASE, '0.2.0')).result).toMatchObject({
      status: 'up-to-date',
      latest: '0.2.0',
    });
    expect((await check(RELEASE, '0.3.0')).result).toMatchObject({ status: 'up-to-date' });
  });

  test('no repo configured -> disabled, no request', async () => {
    const srv = await serve({});
    const r = await checkForUpdate({
      repo: undefined,
      currentVersion: '0.1.0',
      apiBase: srv.base,
      allowLoopbackHttp: true,
      signal: noSignal(),
    });
    expect(r).toEqual({ status: 'disabled' });
    expect(srv.hits).toEqual([]);
    expect((await check(RELEASE, '0.1.0', 200, '')).result).toEqual({ status: 'disabled' });
  });

  test('a malformed repo is refused rather than put into a URL', async () => {
    const r = (await check(RELEASE, '0.1.0', 200, '../../etc')).result;
    expect(r).toMatchObject({ status: 'error', code: 'BAD_REPO' });
  });

  test('drafts and prereleases never trigger the banner', async () => {
    expect((await check({ ...RELEASE, prerelease: true }, '0.1.0')).result.status).toBe(
      'up-to-date',
    );
    expect((await check({ ...RELEASE, draft: true }, '0.1.0')).result.status).toBe('up-to-date');
  });

  test('a release page on another host is replaced by the canonical release URL', async () => {
    const r = (await check({ ...RELEASE, html_url: 'https://evil.example/download' }, '0.1.0'))
      .result;
    expect(r).toMatchObject({
      status: 'available',
      url: `https://github.com/${REPO}/releases/tag/v0.2.0`,
    });
  });

  test('errors are values: 404, rate limit, junk body, unparsable tag, offline', async () => {
    expect((await check({ message: 'Not Found' }, '0.1.0', 404)).result).toMatchObject({
      status: 'error',
      code: 'HTTP',
    });
    expect((await check({ message: 'rate limit' }, '0.1.0', 403)).result).toMatchObject({
      status: 'error',
    });
    expect((await check({ nope: 1 }, '0.1.0')).result).toMatchObject({
      status: 'error',
      code: 'BAD_RESPONSE',
    });
    expect((await check({ ...RELEASE, tag_name: 'nightly' }, '0.1.0')).result).toMatchObject({
      status: 'error',
      code: 'BAD_RESPONSE',
    });
    const offline = await checkForUpdate({
      repo: REPO,
      currentVersion: '0.1.0',
      apiBase: 'http://127.0.0.1:1',
      allowLoopbackHttp: true,
      signal: noSignal(),
    });
    expect(offline).toMatchObject({ status: 'error', code: 'NETWORK' });
  });

  test('sends a User-Agent and the GitHub accept header, and no credentials', async () => {
    let headers: Record<string, string | string[] | undefined> = {};
    const srv = await serve({
      [path]: (req, res) => {
        headers = req.headers;
        res.writeHead(200).end(JSON.stringify(RELEASE));
      },
    });
    await checkForUpdate({
      repo: REPO,
      currentVersion: '0.1.0',
      apiBase: srv.base,
      allowLoopbackHttp: true,
      signal: noSignal(),
    });
    expect(headers['user-agent']).toMatch(/^VoxStudio\/0\.1\.0/);
    expect(headers['accept']).toBe('application/vnd.github+json');
    expect(headers['authorization']).toBeUndefined();
  });

  test('an abort is honoured', async () => {
    const srv = await serve({ [path]: () => undefined });
    const ac = new AbortController();
    const p = checkForUpdate({
      repo: REPO,
      currentVersion: '0.1.0',
      apiBase: srv.base,
      allowLoopbackHttp: true,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    expect(await p).toMatchObject({ status: 'error', code: 'ABORTED' });
  });
});

describe('checkForUpdate response hygiene', () => {
  test('control characters and length are stripped from the release name; the URL is canonical', async () => {
    const r = (
      await check(
        {
          ...RELEASE,
          name: `Vox\u0000 \u001b[31mStudio ${'x'.repeat(400)}`,
          html_url: `https://github.com/${REPO}/releases/../../evil/x`,
        },
        '0.1.0',
      )
    ).result;
    expect(r.status).toBe('available');
    if (r.status !== 'available') return;
    // eslint-disable-next-line no-control-regex
    expect(r.name).not.toMatch(/[\u0000-\u001f]/);
    expect(r.name.length).toBeLessThanOrEqual(200);
    expect(r.url).toBe(`https://github.com/${REPO}/releases/tag/v0.2.0`);
  });

  test('an oversize response is an error value', async () => {
    const srv = await serve({
      [path]: (_req, res) => void res.writeHead(200).end('x'.repeat(2_000_000)),
    });
    const r = await checkForUpdate({
      repo: REPO,
      currentVersion: '0.1.0',
      apiBase: srv.base,
      allowLoopbackHttp: true,
      signal: noSignal(),
    });
    expect(r).toMatchObject({ status: 'error', code: 'HTTP' });
  });
});
