// Key masking, key references and baseUrl checks (agent spec "Configuration and keys", R4 S17, S18).
// Config stores a reference (`keychain:<providerId>` or `env:NAME`), never a key. The UI sees the
// masked form (`sk-or-…a1b2`); a key field that is absent or masked on save means "unchanged".
import { UtilError } from '../errors.pending.ts';

const ELLIPSIS = '…';
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Shortest key that shows its last four characters; shorter keys show nothing. */
const MIN_REVEAL_LENGTH = 16;

/** Mask a key: letters-only vendor prefix segments (`sk-or-`), an ellipsis, the last four characters. */
export function maskKey(key: string): string {
  if (key.length < MIN_REVEAL_LENGTH) return ELLIPSIS;
  const prefix = /^(?:[A-Za-z]{1,6}-){1,3}/.exec(key)?.[0] ?? '';
  return `${prefix}${ELLIPSIS}${key.slice(-4)}`;
}

/** True for a string produced by `maskKey` (real keys and refs never contain the ellipsis). */
export function isMaskedKey(value: string): boolean {
  return /^[A-Za-z-]*…[A-Za-z0-9_-]{0,4}$/.test(value);
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

const KEY_PARAM =
  /(^|[-_.])(api[-_]?key|key|token|secret|password|passwd|pwd|auth|authorization|credential|signature|sig)s?$/i;
const KEY_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|AIza[0-9A-Za-z_-]{20,})/;

const reject = (why: string): never => {
  throw new UtilError(
    'CONFIG_INVALID',
    `baseUrl is not allowed: ${why}`,
    "Remove credentials from the base URL and put the key in the provider's API key field.",
  );
};

function checkParams(params: URLSearchParams): void {
  for (const [name, value] of params) {
    if (KEY_PARAM.test(name)) reject('it has a key-like query parameter');
    if (KEY_VALUE.test(value)) reject('it has a key-like value');
  }
}

/** Reject a `baseUrl` that carries credentials (userinfo, key-like query/fragment) or is not http(s). */
export function assertSafeBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('it is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return reject('it must be http or https');
  if (url.username !== '' || url.password !== '')
    return reject('it contains a user name or password');
  checkParams(url.searchParams);
  const hash = url.hash.replace(/^#/, '');
  if (hash.includes('=')) checkParams(new URLSearchParams(hash));
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  if (KEY_VALUE.test(path) || KEY_VALUE.test(hash)) return reject('it has a key-like value');
  return url;
}
