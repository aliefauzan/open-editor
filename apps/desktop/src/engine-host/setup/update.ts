// "New version" banner data (app spec "Packaging and sharing"): GitHub Releases API, newer tag wins.
// No auto-update, no credentials, off when no repo is configured. Failures are values, never throws,
// so a missing network cannot break app start.

import { isAbortError } from './errors.ts';
import { SetupError } from './errors.ts';
import { fetchChecked, readTextLimited } from './http.ts';
import { compareVersions, parseVersion } from './version.ts';

export type UpdateResult =
  | { status: 'disabled' }
  | { status: 'up-to-date'; current: string; latest: string }
  | {
      status: 'available';
      current: string;
      latest: string;
      tag: string;
      name: string;
      url: string;
      publishedAt?: string;
    }
  | {
      status: 'error';
      code: 'BAD_REPO' | 'HTTP' | 'NETWORK' | 'BAD_RESPONSE' | 'ABORTED';
      message: string;
    };

export interface UpdateOptions {
  /** `owner/name`; undefined or empty turns the check off. */
  repo: string | undefined;
  currentVersion: string;
  signal: AbortSignal;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function checkForUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const repo = opts.repo;
  if (repo === undefined || repo === '') return { status: 'disabled' };
  if (!REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
    return { status: 'error', code: 'BAD_REPO', message: `not an owner/name repo: ${repo}` };
  }
  if (parseVersion(opts.currentVersion) === undefined) {
    return {
      status: 'error',
      code: 'BAD_RESPONSE',
      message: `app version is not semver: ${opts.currentVersion}`,
    };
  }
  const base = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 10_000)]);
  let text: string;
  try {
    const res = await fetchChecked(`${base}/repos/${repo}/releases/latest`, {
      signal,
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: opts.allowLoopbackHttp }),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `VoxStudio/${opts.currentVersion}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    text = await readTextLimited(res, 1024 * 1024);
  } catch (e) {
    if (isAbortError(e) || signal.aborted) {
      return { status: 'error', code: 'ABORTED', message: 'update check cancelled or timed out' };
    }
    if (e instanceof SetupError) {
      return { status: 'error', code: e.code === 'HTTP' ? 'HTTP' : 'NETWORK', message: e.message };
    }
    return {
      status: 'error',
      code: 'NETWORK',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  let release: unknown;
  try {
    release = JSON.parse(text);
  } catch {
    return { status: 'error', code: 'BAD_RESPONSE', message: 'release response is not JSON' };
  }
  if (typeof release !== 'object' || release === null) {
    return { status: 'error', code: 'BAD_RESPONSE', message: 'release response is not an object' };
  }
  const r = release as Record<string, unknown>;
  const tag = r['tag_name'];
  if (typeof tag !== 'string') {
    return { status: 'error', code: 'BAD_RESPONSE', message: 'release has no tag_name' };
  }
  const latest = parseVersion(tag);
  if (latest === undefined) {
    return { status: 'error', code: 'BAD_RESPONSE', message: `release tag is not semver: ${tag}` };
  }
  const latestText = tag.replace(/^v/, '');
  if (r['draft'] === true || r['prerelease'] === true) {
    return { status: 'up-to-date', current: opts.currentVersion, latest: opts.currentVersion };
  }
  if (compareVersions(latestText, opts.currentVersion) <= 0) {
    return { status: 'up-to-date', current: opts.currentVersion, latest: latestText };
  }
  // Only ever link to this repo's release pages, whatever the response says.
  const canonical = `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
  const html = r['html_url'];
  const url =
    typeof html === 'string' && html.startsWith(`https://github.com/${repo}/releases/`)
      ? html
      : canonical;
  const name = typeof r['name'] === 'string' && r['name'] !== '' ? r['name'] : tag;
  const published = r['published_at'];
  return {
    status: 'available',
    current: opts.currentVersion,
    latest: latestText,
    tag,
    name,
    url,
    ...(typeof published === 'string' ? { publishedAt: published } : {}),
  };
}
