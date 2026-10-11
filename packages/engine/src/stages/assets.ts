// Archive assets (engine spec "Archive assets and licences", plan phase 05, S7, S29): search Wikimedia
// Commons and Openverse for images under the licence allowlist (CC0, Public Domain Mark, CC BY,
// CC BY-SA), cache the candidates per query, and download a chosen candidate through the in-process
// private-address check. Cutout and generate live in `media-api` (they need the Python bridge and the
// image provider registry); this module is pure network + parsing.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import type { Resolver } from '../net/address.ts';
import type { Dial } from '../net/proxy.ts';
import { fetchPublic, readBody } from '../net/fetch.ts';
import { sleep as defaultSleep, withRetry } from '../net/retry.ts';
import { writeAtomic } from '../history/files.ts';

export const LICENSES = ['CC0', 'PDM', 'CC BY', 'CC BY-SA'] as const;
export type License = (typeof LICENSES)[number];
export const ASSET_SOURCES = ['commons', 'openverse'] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

/** Openverse anonymous limit (engine spec): never ask for more per page. */
export const OPENVERSE_PAGE_SIZE = 20;
/** Commons without a contact in the User-Agent: at most this many requests per minute (D-12). */
export const COMMONS_ANON_PER_MIN = 10;
/** Largest archive image the engine downloads. */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export const BY_SA_WARNING =
  'CC BY-SA: ShareAlike may apply to the whole video; credit the author and keep the licence.';

export const AssetCandidateSchema = z.strictObject({
  id: z.string().regex(/^(commons|openverse)-[A-Za-z0-9-]{1,64}$/),
  source: z.enum(ASSET_SOURCES),
  title: z.string(),
  url: z.string().url(),
  pageUrl: z.string().url(),
  thumbnailUrl: z.string().url().optional(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  license: z.enum(LICENSES),
  licenseVersion: z.string().optional(),
  licenseUrl: z.string().optional(),
  author: z.string(),
  attribution: z.string(),
  warning: z.string().optional(),
});
export type AssetCandidate = z.infer<typeof AssetCandidateSchema>;

const CacheFileSchema = z.strictObject({
  query: z.string(),
  sources: z.array(z.enum(ASSET_SOURCES)),
  fetchedAt: z.string(),
  candidates: z.array(AssetCandidateSchema),
  dropped: z.int().min(0),
});
type CacheFile = z.infer<typeof CacheFileSchema>;

export interface SearchResult {
  query: string;
  sources: AssetSource[];
  candidates: AssetCandidate[];
  /** Results dropped by the licence allowlist (NC, ND, other). */
  dropped: number;
  cached: boolean;
  /** Set when nothing was found; nothing is generated or substituted (engine "Error handling"). */
  message?: 'no results';
}

// ---- licences (S7) ----

/**
 * Maps an archive licence string to the allowlist, or undefined (dropped). NC and ND are always
 * dropped; Commons public-domain tags (`pd`, `PD-…`, "Public domain") count as the Public Domain Mark.
 */
export function classifyLicense(raw: string | undefined): License | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (s === '') return undefined;
  const parts = s.split('-');
  if (parts.includes('nc') || parts.includes('nd')) return undefined;
  if (/^cc0(-|$)/.test(s) || s === 'cc-zero') return 'CC0';
  if (s === 'pdm' || /^pd(-|$)/.test(s) || /^public-domain(-|$)/.test(s)) return 'PDM';
  if (/^(cc-)?by-sa(-|$)/.test(s)) return 'CC BY-SA';
  if (/^(cc-)?by(-\d|$)/.test(s)) return 'CC BY';
  return undefined;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Commons `Artist` HTML → plain text: tags (and script/style bodies) removed, entities decoded. */
export function htmlToText(html: string, max = 200): string {
  const noBlocks = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const noTags = noBlocks
    .replace(/<\/?(br|p|div|li|ul|ol|tr|td|th|table|h\d)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  const decoded = noTags.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 && (n < 0xd800 || n > 0xdfff)
        ? String.fromCodePoint(n)
        : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // eslint-disable-next-line no-control-regex
  const clean = decoded.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ');
  const out = clean.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const shortName = (l: License, version?: string): string =>
  version && l !== 'CC0' && l !== 'PDM' ? `${l} ${version}` : l;

function candidate(
  c: Omit<AssetCandidate, 'attribution' | 'warning'>,
  sourceLabel: string,
): AssetCandidate {
  const author = c.author || 'unknown author';
  const lic = shortName(c.license, c.licenseVersion);
  return {
    ...c,
    author,
    attribution: `"${c.title}" by ${author}, ${lic}, via ${sourceLabel}`,
    ...(c.license === 'CC BY-SA' ? { warning: BY_SA_WARNING } : {}),
  };
}

const isHttpUrl = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};
const posInt = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
const absUrl = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.startsWith('//') ? `https:${s}` : s;
  return isHttpUrl(t) ? t : undefined;
};
const opt = <K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } =>
  (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };

// ---- response parsing ----

/** Openverse `/v1/images/` JSON → allowed candidates (+ dropped count). */
export function parseOpenverse(json: unknown): { candidates: AssetCandidate[]; dropped: number } {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return { candidates: [], dropped: 0 };
  const out: AssetCandidate[] = [];
  let dropped = 0;
  for (const r of results as Record<string, unknown>[]) {
    const license = classifyLicense(typeof r['license'] === 'string' ? r['license'] : undefined);
    const id = typeof r['id'] === 'string' ? r['id'] : '';
    const url = absUrl(r['url']);
    const page = absUrl(r['foreign_landing_url']) ?? url;
    if (!license || !/^[A-Za-z0-9-]{1,64}$/.test(id) || !url || !page) {
      dropped++;
      continue;
    }
    const version = typeof r['license_version'] === 'string' ? r['license_version'] : undefined;
    out.push(
      candidate(
        {
          id: `openverse-${id}`,
          source: 'openverse',
          title: htmlToText(String(r['title'] ?? 'Untitled')) || 'Untitled',
          url,
          pageUrl: page,
          ...opt('thumbnailUrl', absUrl(r['thumbnail'])),
          ...opt('width', posInt(r['width'])),
          ...opt('height', posInt(r['height'])),
          license,
          ...opt('licenseVersion', version),
          ...opt('licenseUrl', absUrl(r['license_url'])),
          author: htmlToText(String(r['creator'] ?? '')),
        },
        'Openverse',
      ),
    );
  }
  return { candidates: out, dropped };
}

/** Commons `generator=search` + `imageinfo` JSON → allowed bitmap candidates (+ dropped count). */
export function parseCommons(json: unknown): { candidates: AssetCandidate[]; dropped: number } {
  const pages = (json as { query?: { pages?: unknown } })?.query?.pages;
  if (!Array.isArray(pages)) return { candidates: [], dropped: 0 };
  const sorted = [...(pages as Record<string, unknown>[])].sort(
    (a, b) => Number(a['index'] ?? 0) - Number(b['index'] ?? 0),
  );
  const out: AssetCandidate[] = [];
  let dropped = 0;
  for (const p of sorted) {
    const ii = (p['imageinfo'] as Record<string, unknown>[] | undefined)?.[0];
    const em = (ii?.['extmetadata'] ?? {}) as Record<string, { value?: unknown } | undefined>;
    const val = (k: string) => (typeof em[k]?.value === 'string' ? (em[k].value as string) : '');
    const license = classifyLicense(val('License') || val('LicenseShortName'));
    const pageid = posInt(p['pageid']);
    const mime = typeof ii?.['mime'] === 'string' ? (ii['mime'] as string) : '';
    const url = absUrl(ii?.['thumburl']) ?? absUrl(ii?.['url']);
    const page = absUrl(ii?.['descriptionurl']);
    if (!license || !pageid || !url || !page || !/^image\/(jpeg|png|webp)$/.test(mime)) {
      dropped++;
      continue;
    }
    const version = /(\d+(\.\d+)?)/.exec(val('LicenseShortName'))?.[1];
    const title =
      htmlToText(val('ObjectName')) ||
      String(p['title'] ?? '')
        .replace(/^File:/, '')
        .replace(/\.[a-z0-9]+$/i, '');
    out.push(
      candidate(
        {
          id: `commons-${pageid}`,
          source: 'commons',
          title: title || 'Untitled',
          url,
          pageUrl: page,
          ...opt('thumbnailUrl', absUrl(ii?.['thumburl'])),
          ...opt('width', posInt(ii?.['thumbwidth']) ?? posInt(ii?.['width'])),
          ...opt('height', posInt(ii?.['thumbheight']) ?? posInt(ii?.['height'])),
          license,
          ...opt('licenseVersion', version),
          ...opt('licenseUrl', absUrl(val('LicenseUrl'))),
          author: htmlToText(val('Artist')),
        },
        'Wikimedia Commons',
      ),
    );
  }
  return { candidates: out, dropped };
}

// ---- requests ----

export function openverseUrl(query: string, pageSize = OPENVERSE_PAGE_SIZE): string {
  const u = new URL('https://api.openverse.org/v1/images/');
  u.searchParams.set('q', query);
  u.searchParams.set('license', 'cc0,pdm,by,by-sa');
  u.searchParams.set('page_size', String(Math.min(OPENVERSE_PAGE_SIZE, Math.max(1, pageSize))));
  return u.toString();
}

export function commonsUrl(query: string, limit = 20): string {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  const p: Record<string, string> = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(50, Math.max(1, limit))),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1920',
    iiextmetadatafilter: 'License|LicenseShortName|LicenseUrl|Artist|ObjectName',
  };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}

/** `VoxStudio/<version> (<contact>)`; without a contact the agent string has no comment. */
export function userAgent(version: string, contact?: string): string {
  // eslint-disable-next-line no-control-regex
  const c = contact?.replace(/[\u0000-\u001f\u007f()]/g, '').trim();
  return c ? `VoxStudio/${version} (${c})` : `VoxStudio/${version}`;
}

/** Sliding-window limiter: at most `perMinute` starts in any 60 s. */
export function createThrottle(
  perMinute: number,
  o: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): (signal?: AbortSignal) => Promise<void> {
  const now = o.now ?? Date.now;
  const wait = o.sleep ?? defaultSleep;
  const starts: number[] = [];
  let chain: Promise<void> = Promise.resolve();
  return (signal) => {
    const next = chain.then(async () => {
      for (;;) {
        const t = now();
        while (starts.length > 0 && t - starts[0]! >= 60_000) starts.shift();
        if (starts.length < perMinute) {
          starts.push(t);
          return;
        }
        await wait(starts[0]! + 60_000 - t, signal);
      }
    });
    chain = next.catch(() => undefined);
    return next;
  };
}

export interface AssetNet {
  resolver?: Resolver;
  dial?: Dial;
  /** Extra trusted CA (tests). */
  ca?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** GET JSON (Accept JSON, User-Agent), with the S29 check and 3 retries on transient failures. */
export type GetJson = (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<unknown>;

const retryable = (e: unknown): boolean =>
  e instanceof VoxError && (e.code === 'TOOL_FAILED' || e.code === 'NET_DNS');

export function httpGetJson(net: AssetNet = {}): GetJson {
  return (url, headers, signal) =>
    withRetry(
      async () => {
        const res = await fetchPublic(url, {
          headers: { accept: 'application/json', ...headers },
          ...(net.resolver ? { resolver: net.resolver } : {}),
          ...(net.dial ? { dial: net.dial } : {}),
          ...(net.ca ? { ca: net.ca } : {}),
          ...(signal ? { signal } : {}),
          timeoutMs: 30_000,
        });
        const body = await readBody(res, MAX_JSON_BYTES);
        if (res.status !== 200) {
          throw new VoxError(
            'TOOL_FAILED',
            `${new URL(url).host} answered HTTP ${res.status}.`,
            'Try again later; the archive may be rate-limiting.',
            { details: { status: res.status } },
          );
        }
        try {
          return JSON.parse(body.toString('utf8')) as unknown;
        } catch (e) {
          throw new VoxError(
            'TOOL_FAILED',
            `${new URL(url).host} sent a reply that is not JSON.`,
            'Try again later.',
            { cause: e },
          );
        }
      },
      {
        retryable,
        ...(net.sleep ? { sleep: net.sleep } : {}),
        ...(signal ? { signal } : {}),
      },
    );
}

export interface SearchEnv {
  projectDir: string;
  version: string;
  /** From `readConfig()`; without it Commons is throttled to 10/min. */
  contact?: string;
  getJson: GetJson;
  /** Commons limiter used when there is no contact. */
  commonsThrottle?: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  now?: () => Date;
}

export const SearchArgsSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
  sources: z.array(z.enum(ASSET_SOURCES)).min(1).optional(),
  limit: z.int().min(1).max(OPENVERSE_PAGE_SIZE).optional(),
});
export type SearchArgs = z.infer<typeof SearchArgsSchema>;

const sharedCommonsThrottle = createThrottle(COMMONS_ANON_PER_MIN);

export function queryHash(query: string, sources: readonly AssetSource[], limit: number): string {
  return createHash('sha256')
    .update(JSON.stringify([query.trim().toLowerCase(), [...sources].sort(), limit]))
    .digest('hex')
    .slice(0, 32);
}

const cacheDir = (projectDir: string) => join(projectDir, 'cache', 'assets');

/** Searches the archives (or reads the query's cache file) and returns allowlisted candidates. */
export async function searchAssets(env: SearchEnv, raw: SearchArgs): Promise<SearchResult> {
  const args = SearchArgsSchema.parse(raw);
  const sources = [...new Set(args.sources ?? ASSET_SOURCES)];
  const limit = args.limit ?? OPENVERSE_PAGE_SIZE;
  const file = join(cacheDir(env.projectDir), `${queryHash(args.query, sources, limit)}.json`);
  try {
    const hit = CacheFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    return finish(args.query, sources, hit.candidates, hit.dropped, true);
  } catch {
    // search
  }
  const ua = userAgent(env.version, env.contact);
  const candidates: AssetCandidate[] = [];
  let dropped = 0;
  for (const s of sources) {
    if (s === 'openverse') {
      const r = parseOpenverse(
        await env.getJson(openverseUrl(args.query, limit), { 'user-agent': ua }, env.signal),
      );
      candidates.push(...r.candidates.slice(0, limit));
      dropped += r.dropped;
    } else {
      if (!env.contact) await (env.commonsThrottle ?? sharedCommonsThrottle)(env.signal);
      const r = parseCommons(
        await env.getJson(commonsUrl(args.query, limit), { 'user-agent': ua }, env.signal),
      );
      candidates.push(...r.candidates.slice(0, limit));
      dropped += r.dropped;
    }
  }
  const seen = new Set<string>();
  const unique = candidates.filter((c) => !seen.has(c.id) && seen.add(c.id));
  const entry: CacheFile = {
    query: args.query,
    sources,
    fetchedAt: (env.now ?? (() => new Date()))().toISOString(),
    candidates: unique,
    dropped,
  };
  await mkdir(cacheDir(env.projectDir), { recursive: true, mode: 0o700 });
  await writeAtomic(file, JSON.stringify(entry));
  return finish(args.query, sources, unique, dropped, false);
}

function finish(
  query: string,
  sources: AssetSource[],
  candidates: AssetCandidate[],
  dropped: number,
  cached: boolean,
): SearchResult {
  return {
    query,
    sources,
    candidates,
    dropped,
    cached,
    ...(candidates.length === 0 ? { message: 'no results' as const } : {}),
  };
}

/** A candidate from any cached search of the project (newest cache file first). */
export async function findCandidate(projectDir: string, id: string): Promise<AssetCandidate> {
  let names: string[] = [];
  try {
    names = (await readdir(cacheDir(projectDir))).filter((n) => /^[0-9a-f]{32}\.json$/.test(n));
  } catch {
    // no searches yet
  }
  const found: { at: string; c: AssetCandidate }[] = [];
  for (const n of names) {
    try {
      const f = CacheFileSchema.parse(
        JSON.parse(await readFile(join(cacheDir(projectDir), n), 'utf8')),
      );
      const c = f.candidates.find((x) => x.id === id);
      if (c) found.push({ at: f.fetchedAt, c });
    } catch {
      continue;
    }
  }
  found.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const hit = found[0]?.c;
  if (!hit) {
    throw new VoxError(
      'NOT_FOUND',
      `No search result ${id} in this project.`,
      'Run `vox assets search` first and use a candidate id from its result.',
      { details: { candidateId: id } },
    );
  }
  return hit;
}

/**
 * Downloads `url` to `dest` through the S29 check (every hop resolved and checked, connected to the
 * checked address), capped at MAX_ASSET_BYTES; a partial file is removed on failure.
 */
export async function downloadAsset(
  url: string,
  dest: string,
  o: AssetNet & { headers?: Record<string, string>; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<void> {
  const max = o.maxBytes ?? MAX_ASSET_BYTES;
  await withRetry(
    async () => {
      const res = await fetchPublic(url, {
        ...(o.headers ? { headers: o.headers } : {}),
        ...(o.resolver ? { resolver: o.resolver } : {}),
        ...(o.dial ? { dial: o.dial } : {}),
        ...(o.ca ? { ca: o.ca } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        timeoutMs: 60_000,
      });
      if (res.status !== 200) {
        res.body.resume();
        throw new VoxError(
          'TOOL_FAILED',
          `The archive download returned HTTP ${res.status}.`,
          'Try again later, or pick another candidate.',
          { details: { status: res.status } },
        );
      }
      let size = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > max) {
            cb(
              new VoxError(
                'NET_TOO_LARGE',
                `The archive file is over ${Math.round(max / 1024 / 1024)} MiB.`,
                'Pick a smaller candidate.',
              ),
            );
            return;
          }
          cb(null, chunk);
        },
      });
      try {
        await pipeline(res.body, cap, createWriteStream(dest, { mode: 0o600 }));
      } catch (e) {
        await unlink(dest).catch(() => undefined);
        throw e;
      }
    },
    {
      retryable,
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    },
  );
}

/** The media `origin` an archive candidate records (licence, author, link). */
export function archiveOrigin(c: AssetCandidate): {
  type: 'archive';
  url: string;
  license: string;
  licenseUrl?: string;
  author: string;
  attribution: string;
} {
  return {
    type: 'archive',
    url: c.pageUrl,
    license: shortName(c.license, c.licenseVersion),
    ...(c.licenseUrl ? { licenseUrl: c.licenseUrl } : {}),
    author: c.author,
    attribution: c.attribution,
  };
}

/** True when a recorded licence string forbids derivatives (cutout refused, S7). */
export function isNoDerivatives(license: string | undefined): boolean {
  if (!license) return false;
  return license
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .split('-')
    .includes('nd');
}
