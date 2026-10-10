// Archive search and fetch (phase 05 steps 1–2, S7, S29): licence allowlist, recorded Commons and
// Openverse replies (no live network), cache per query, "no results", the Commons throttle and the
// private-address check on archive downloads (fake resolver, local servers).
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.ts';
import type { Resolver } from '../../src/net/address.ts';
import {
  BY_SA_WARNING,
  archiveOrigin,
  classifyLicense,
  commonsUrl,
  createThrottle,
  downloadAsset,
  findCandidate,
  htmlToText,
  isNoDerivatives,
  openverseUrl,
  parseCommons,
  parseOpenverse,
  searchAssets,
  userAgent,
  type GetJson,
} from '../../src/stages/assets.ts';
import { PUBLIC_HOST, PUBLIC_IP, httpServer, text } from '../net/servers.ts';
import type { TestServer } from '../net/servers.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'assets-http');
const rec = (n: string): unknown => JSON.parse(readFileSync(join(FIX, n), 'utf8'));

describe('licence allowlist (S7)', () => {
  test.each([
    ['cc0', 'CC0'],
    ['CC0 1.0', 'CC0'],
    ['pdm', 'PDM'],
    ['pd', 'PDM'],
    ['PD-old-70', 'PDM'],
    ['Public domain', 'PDM'],
    ['by', 'CC BY'],
    ['cc-by-4.0', 'CC BY'],
    ['CC BY 2.0', 'CC BY'],
    ['by-sa', 'CC BY-SA'],
    ['cc-by-sa-3.0-de', 'CC BY-SA'],
  ])('%s → %s', (raw, want) => expect(classifyLicense(raw)).toBe(want));

  test.each([
    'by-nc',
    'by-nd',
    'by-nc-sa',
    'by-nc-nd',
    'cc-by-nc-sa-4.0',
    'CC BY-ND 4.0',
    'gfdl',
    'sampling+',
    'nc-sampling+',
    'copyrighted',
    '',
    undefined,
  ])('%s is dropped', (raw) => expect(classifyLicense(raw)).toBeUndefined());

  test('ND licences refuse derivatives; others do not', () => {
    expect(isNoDerivatives('CC BY-ND 4.0')).toBe(true);
    expect(isNoDerivatives('cc-by-nc-nd-4.0')).toBe(true);
    expect(isNoDerivatives('CC BY-SA 4.0')).toBe(false);
    expect(isNoDerivatives(undefined)).toBe(false);
  });
});

describe('recorded replies', () => {
  test('Openverse: NC/ND/other dropped, BY-SA warns, attribution complete', () => {
    const r = parseOpenverse(rec('openverse-lisbon-tram.json'));
    expect(r.dropped).toBe(3);
    expect(r.candidates).toHaveLength(6);
    for (const c of r.candidates) {
      expect(['CC0', 'PDM', 'CC BY', 'CC BY-SA']).toContain(c.license);
      expect(c.id).toMatch(/^openverse-/);
      expect(c.attribution).toContain(c.author);
      expect(c.url).toMatch(/^https:\/\//);
      expect(c.warning === BY_SA_WARNING).toBe(c.license === 'CC BY-SA');
    }
    expect(r.candidates.some((c) => c.license === 'CC BY-SA')).toBe(true);
  });

  test('Commons: NC/ND/GFDL dropped, PD and CC0 kept, Artist HTML sanitised', () => {
    const r = parseCommons(rec('commons-lisbon-tram.json'));
    expect(r.dropped).toBe(3);
    const ids = r.candidates.map((c) => c.id);
    expect(ids).toContain('commons-900004');
    expect(ids).toContain('commons-900005');
    expect(ids).not.toContain('commons-900001');
    expect(ids).not.toContain('commons-900002');
    expect(ids).not.toContain('commons-900003');
    const pd = r.candidates.find((c) => c.id === 'commons-900005')!;
    expect(pd.license).toBe('PDM');
    expect(pd.author).toBe('Unknown author & friends');
    for (const c of r.candidates) {
      expect(c.author).not.toMatch(/[<>]/);
      expect(c.pageUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
    expect(r.candidates.find((c) => c.license === 'CC BY-SA')?.warning).toBe(BY_SA_WARNING);
  });

  test('htmlToText strips tags, scripts and entities', () => {
    expect(htmlToText('<a href="x">Jane &amp; Joe</a>&#33;<script>alert(1)</script>')).toBe(
      'Jane & Joe!',
    );
    expect(htmlToText('a&#0;b&#x1F600;')).toBe('a b😀');
  });

  test('query URLs: Openverse licence list and page size ≤ 20; Commons bitmap search', () => {
    const o = new URL(openverseUrl('lisbon tram', 50));
    expect(o.searchParams.get('license')).toBe('cc0,pdm,by,by-sa');
    expect(o.searchParams.get('page_size')).toBe('20');
    const c = new URL(commonsUrl('lisbon tram'));
    expect(c.host).toBe('commons.wikimedia.org');
    expect(c.searchParams.get('gsrsearch')).toBe('lisbon tram filetype:bitmap');
  });

  test('User-Agent carries the contact, and none without it', () => {
    expect(userAgent('1.2.3', 'https://example.org/contact')).toBe(
      'VoxStudio/1.2.3 (https://example.org/contact)',
    );
    expect(userAgent('1.2.3')).toBe('VoxStudio/1.2.3');
    expect(userAgent('1.2.3', 'a)(b\n')).toBe('VoxStudio/1.2.3 (ab)');
  });
});

describe('searchAssets', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vox-assets-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const fake = (calls: { url: string; ua: string }[], empty = false): GetJson =>
    async (url, headers) => {
      calls.push({ url, ua: headers['user-agent'] ?? '' });
      const host = new URL(url).host;
      if (host === 'api.openverse.org')
        return rec(empty ? 'openverse-empty.json' : 'openverse-lisbon-tram.json');
      return rec(empty ? 'commons-empty.json' : 'commons-lisbon-tram.json');
    };

  test('searches both sources, caches by query, second call reads the cache', async () => {
    const calls: { url: string; ua: string }[] = [];
    const env = {
      projectDir: dir,
      version: '0.0.0',
      contact: 'https://example.org/c',
      getJson: fake(calls),
    };
    const a = await searchAssets(env, { query: 'Lisbon tram' });
    expect(a.cached).toBe(false);
    expect(a.candidates.length).toBe(6 + 10);
    expect(a.dropped).toBe(6);
    expect(calls.map((c) => new URL(c.url).host).sort()).toEqual([
      'api.openverse.org',
      'commons.wikimedia.org',
    ]);
    expect(calls.every((c) => c.ua === 'VoxStudio/0.0.0 (https://example.org/c)')).toBe(true);
    expect(readdirSync(join(dir, 'cache', 'assets')).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    const b = await searchAssets(env, { query: ' lisbon tram ' });
    expect(b.cached).toBe(true);
    expect(calls).toHaveLength(2);
    expect(b.candidates).toEqual(a.candidates);
    const c = await findCandidate(dir, 'commons-900004');
    expect(archiveOrigin(c)).toMatchObject({ type: 'archive', license: 'CC0' });
    await expect(findCandidate(dir, 'commons-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('an empty result says "no results" and substitutes nothing', async () => {
    const calls: { url: string; ua: string }[] = [];
    const r = await searchAssets(
      { projectDir: dir, version: '0.0.0', getJson: fake(calls, true), commonsThrottle: async () => {} },
      { query: 'zzqqxxnotathing' },
    );
    expect(r.candidates).toEqual([]);
    expect(r.message).toBe('no results');
  });

  test('without a contact, Commons goes through the throttle', async () => {
    let throttled = 0;
    await searchAssets(
      {
        projectDir: dir,
        version: '0.0.0',
        getJson: fake([]),
        commonsThrottle: async () => {
          throttled++;
        },
      },
      { query: 'tram anon', sources: ['commons'] },
    );
    expect(throttled).toBe(1);
  });
});

describe('Commons throttle (10/min without contact)', () => {
  test('the 11th request in a minute waits until the window frees', async () => {
    let t = 0;
    const waits: number[] = [];
    const th = createThrottle(10, {
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    for (let i = 0; i < 10; i++) {
      await th();
      t += 1000;
    }
    expect(waits).toEqual([]);
    await th();
    expect(waits).toEqual([50_000]);
  });
});

describe('archive download: private-address check (S29)', () => {
  let target: TestServer;
  let publicSrv: TestServer;
  let dir: string;
  const resolver: Resolver = async (host) => {
    if (host === PUBLIC_HOST) return [PUBLIC_IP];
    if (host === 'archive-internal.test') return ['127.0.0.1'];
    if (host === 'mixed.test')
      return [PUBLIC_IP, '10.0.0.5'];
    throw new VoxError('NET_DNS', `no ${host}`, 'x');
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vox-assets-dl-'));
    target = await httpServer(text('secret internal image'));
    publicSrv = await httpServer((req, res) => {
      if (req.url === '/to-private') {
        res.writeHead(302, { location: `http://archive-internal.test:${target.port}/x.jpg` });
        res.end();
        return;
      }
      if (req.url === '/to-loopback-ip') {
        res.writeHead(302, { location: `http://127.0.0.1:${target.port}/x.jpg` });
        res.end();
        return;
      }
      text('public image bytes')(req, res);
    });
  });
  afterAll(async () => {
    await target.close();
    await publicSrv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const dial = (addr: string, port: number) =>
    addr === PUBLIC_IP ? { host: '127.0.0.1', port: publicSrv.port } : { host: addr, port };
  const o = () => ({ resolver, dial, sleep: async () => {} });

  test('a public host downloads', async () => {
    const f = join(dir, 'ok.bin');
    await downloadAsset(`http://${PUBLIC_HOST}/a.jpg`, f, o());
    expect(readFileSync(f, 'utf8')).toBe('public image bytes');
  });

  test.each([
    ['a host that resolves to loopback', () => `http://archive-internal.test:${target.port}/x.jpg`],
    ['a host with one private answer', () => `http://mixed.test:${target.port}/x.jpg`],
    ['a literal loopback address', () => `http://127.0.0.1:${target.port}/x.jpg`],
    ['a redirect to a private host', () => `http://${PUBLIC_HOST}/to-private`],
    ['a redirect to a loopback IP', () => `http://${PUBLIC_HOST}/to-loopback-ip`],
  ])('%s is refused with NET_BLOCKED and leaves no file', async (_n, url) => {
    const f = join(dir, `blocked-${Math.random()}.bin`);
    await expect(downloadAsset(url(), f, o())).rejects.toMatchObject({ code: 'NET_BLOCKED' });
    expect(existsSync(f)).toBe(false);
  });

  test('a file over the cap fails NET_TOO_LARGE and leaves no file', async () => {
    const f = join(dir, 'big.bin');
    await expect(
      downloadAsset(`http://${PUBLIC_HOST}/a.jpg`, f, { ...o(), maxBytes: 4 }),
    ).rejects.toMatchObject({ code: 'NET_TOO_LARGE' });
    expect(existsSync(f)).toBe(false);
  });
});
