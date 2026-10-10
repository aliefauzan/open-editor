// Ingest sources (engine spec "Ingest sources", D-13). `classifyUrl` labels a link for the UI badge
// and error hints only; every link takes the same yt-dlp path through the filtering proxy.

export type UrlKind = 'youtube' | 'instagram' | 'tiktok' | 'other' | 'invalid';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const TIKTOK_SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

const ID = '[A-Za-z0-9_-]+';
const YOUTUBE_PATH = new RegExp(`^/(shorts|live|embed)/${ID}/?$`);
const YOUTU_BE_PATH = new RegExp(`^/${ID}/?$`);
// /reel/<id>, /reels/<id>, /p/<id>, /tv/<id>, optionally after a user name
const INSTAGRAM_PATH = new RegExp(`^(/[A-Za-z0-9._]+)?/(reels?|p|tv)/${ID}/?$`);
const TIKTOK_PATH = new RegExp(`^(/@[A-Za-z0-9._-]+/video/\\d+|/v/\\d+\\.html|/t/${ID})/?$`);
const TIKTOK_SHORT_PATH = new RegExp(`^/${ID}/?$`);

function isYoutube(host: string, url: URL): boolean {
  if (host === 'youtu.be') return YOUTU_BE_PATH.test(url.pathname);
  if (!YOUTUBE_HOSTS.has(host)) return false;
  if (url.pathname === '/watch' || url.pathname === '/watch/') {
    return (url.searchParams.get('v') ?? '') !== '';
  }
  return YOUTUBE_PATH.test(url.pathname);
}

/**
 * `youtube` (watch, youtu.be, Shorts), `instagram` (reel, post, IGTV), `tiktok` (video page and
 * `vm.`/`vt.` short links), `other` for any other http(s) URL, `invalid` for anything that is not an
 * http(s) URL.
 */
export function classifyUrl(raw: string): UrlKind {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'invalid';
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    return 'invalid';
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isYoutube(host, url)) return 'youtube';
  if (INSTAGRAM_HOSTS.has(host) && INSTAGRAM_PATH.test(url.pathname)) return 'instagram';
  if (TIKTOK_HOSTS.has(host) && TIKTOK_PATH.test(url.pathname)) return 'tiktok';
  if (TIKTOK_SHORT_HOSTS.has(host) && TIKTOK_SHORT_PATH.test(url.pathname)) return 'tiktok';
  return 'other';
}
