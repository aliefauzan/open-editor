// Key masking, key references and baseUrl checks (agent spec "Configuration and keys", R4 S17, S18).
// Config stores a reference (`keychain:<providerId>` or `env:NAME`), never a key. The UI sees the
// masked form (`sk-or-…a1b2`); a key field that is absent or masked on save means "unchanged".
import { UtilError } from '../errors.pending.ts';

const ELLIPSIS = '…';
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Shortest key that shows its last four characters; shorter keys show nothing. */
const MIN_REVEAL_LENGTH = 24;
/** Vendor prefixes shown as they are; any other key shows only its last four characters. */
const VENDOR_PREFIX = /^sk-(?:or-|ant-|proj-)?/;

/** Mask a key: a known vendor prefix (`sk-or-`), an ellipsis, the last four characters. */
export function maskKey(key: string): string {
  if (key.length < MIN_REVEAL_LENGTH) return ELLIPSIS;
  const prefix = VENDOR_PREFIX.exec(key)?.[0] ?? '';
  return `${prefix}${ELLIPSIS}${key.slice(-4)}`;
}

/** True for a string produced by `maskKey` (printable ASCII around one ellipsis, ≤ 4 after it). */
export function isMaskedKey(value: string): boolean {
  return /^[\x21-\x7e]*…[\x21-\x7e]{0,4}$/.test(value);
}

/** "Masked or absent = unchanged": the save keeps the stored key. */
export function keyInputIsUnchanged(input: string | null | undefined): boolean {
  if (input === undefined || input === null) return true;
  const v = input.trim();
  return v === '' || isMaskedKey(v);
}

export type KeyRef = { kind: 'keychain'; providerId: string } | { kind: 'env'; name: string };

export function formatKeyRef(ref: KeyRef): string {
  if (ref.kind === 'keychain') {
    if (!PROVIDER_ID.test(ref.providerId)) throw new Error('unsafe provider id for a key ref');
    return `keychain:${ref.providerId}`;
  }
  if (!ENV_NAME.test(ref.name)) throw new Error('unsafe environment variable name for a key ref');
  return `env:${ref.name}`;
}

/** Parse a stored `apiKey` value; null when it is not a well-formed reference (e.g. a raw key). */
export function parseKeyRef(value: string): KeyRef | null {
  const keychain = /^keychain:(.+)$/s.exec(value);
  if (keychain) {
    const providerId = keychain[1] as string;
    return PROVIDER_ID.test(providerId) ? { kind: 'keychain', providerId } : null;
  }
  const env = /^env:(.+)$/s.exec(value);
  if (env) {
    const name = env[1] as string;
    return ENV_NAME.test(name) ? { kind: 'env', name } : null;
  }
  return null;
}

// Names are compared without separators and case: api_key, api-key, apiKey, accessToken, …
const KEY_PARAM =
  /(apikey|key|token|secret|password|passwd|pwd|auth|authorization|credential|signature|sig)s?$/;
const KEY_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|AIza[0-9A-Za-z_-]{20,})/;
/** A long opaque path segment mixing letters and digits looks like a token. */
const OPAQUE_SEGMENT = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{24,}$/;

const isKeyName = (name: string): boolean =>
  KEY_PARAM.test(name.replace(/[-_.\s]/g, '').toLowerCase());

const decode = (v: string): string => {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v;
  }
};

const reject = (why: string): never => {
  throw new UtilError(
    'CONFIG_INVALID',
    `baseUrl is not allowed: ${why}`,
    "Remove credentials from the base URL and put the key in the provider's API key field.",
  );
};

/** The query string splits on `&` and `;`. */
function checkQuery(query: string): void {
  for (const part of query.replace(/^\?/, '').split(/[&;]/)) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = decode(eq < 0 ? part : part.slice(0, eq));
    const value = eq < 0 ? '' : decode(part.slice(eq + 1));
    if (isKeyName(name)) reject('it has a key-like query parameter');
    if (KEY_VALUE.test(name) || KEY_VALUE.test(value)) reject('it has a key-like value');
  }
}

function checkPath(pathname: string): void {
  let previousWasKeyName = false;
  for (const raw of pathname.split('/')) {
    const seg = decode(raw);
    if (seg === '') continue;
    if (KEY_VALUE.test(seg) || OPAQUE_SEGMENT.test(seg)) reject('its path has a key-like value');
    // `/key/<value>` and `/api_key/<value>`: the segment after a key-like name is a credential
    if (previousWasKeyName) reject('its path has a key-like value');
    previousWasKeyName = isKeyName(seg);
  }
}

/**
 * Reject a `baseUrl` that carries credentials (userinfo, key-like query parameter, key-like or
 * opaque path segment, any fragment) or is not http(s). Returns the parsed URL.
 */
export function assertSafeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('it is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return reject('it must be http or https');
  }
  if (url.username !== '' || url.password !== '') {
    return reject('it contains a user name or password');
  }
  if (url.hash !== '') return reject('it has a fragment');
  checkQuery(url.search);
  checkPath(url.pathname);
  return url;
}
