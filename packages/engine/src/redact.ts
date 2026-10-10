// Shared secret redactor (engine spec "Library API" → `engine.redactor`; agent spec "Secret redactor";
// plan R4 S19). Applied to VoxError.cause, job errors, logs and events. The agent registers every key
// value it reads with `addSecrets` (phase 11).

export const REDACTED = '[REDACTED]';

/** Registered values shorter than this are ignored, so a mistake never blanks ordinary text. */
const MIN_SECRET_LENGTH = 8;

const HEADER_NAMES =
  'proxy-authorization|authorization|x-goog-api-key|x-api-key|api-key|x-auth-token|set-cookie|cookie';
// `Authorization: value`, `x-api-key=value`, `"authorization":"value"`; the value runs to the end of
// the line, a quote or a closing brace.
const HEADER_LINE = new RegExp(
  `(?<![A-Za-z0-9-])(${HEADER_NAMES})(\\\\?["']?[ \\t]*[:=][ \\t]*\\\\?["']?)([^\\r\\n"'}\\\\]+)`,
  'gi',
);
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SK_KEY = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g;
const QUERY_KEY =
  /(?<![A-Za-z0-9_])(api[_-]?key|key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password)=([^&\s#"'<>]+)/gi;

/** Object keys whose value is replaced whole (compared lower-case without `-` and `_`). */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'xapikey',
  'xgoogapikey',
  'apikey',
  'xauthtoken',
  'cookie',
  'setcookie',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'password',
  'secret',
  'token',
]);

function sensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''));
}

export interface Redactor {
  /** Registers literal secret values (e.g. API keys) to remove from everything redacted later. */
  addSecrets(values: readonly string[]): void;
  /**
   * Returns a redacted copy: strings, arrays, plain objects, Maps, Sets and Errors (incl. `cause`)
   * are walked; values under sensitive keys (`authorization`, `apiKey`, `cookie`, …) are replaced
   * whole. Other class instances (Date, Buffer, …) are returned as they are. Never throws.
   */
  redact<T>(value: T): T;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  let literal: RegExp | undefined;

  function redactText(text: string): string {
    let out = literal ? text.replace(literal, REDACTED) : text;
    out = out.replace(HEADER_LINE, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
    out = out.replace(BEARER, `Bearer ${REDACTED}`);
    out = out.replace(SK_KEY, REDACTED);
    out = out.replace(QUERY_KEY, (_m, name: string) => `${name}=${REDACTED}`);
    return out;
  }

  function define(target: object, key: string | symbol, value: unknown, enumerable: boolean): void {
    Object.defineProperty(target, key, { value, enumerable, writable: true, configurable: true });
  }

  function walkProp(key: string | symbol, v: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof key === 'string' && v !== null && v !== undefined && sensitiveKey(key)) {
      return REDACTED;
    }
    return walk(v, seen);
  }

  function walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === 'string') return redactText(value);
    if (value === null || typeof value !== 'object') return value;
    const hit = seen.get(value);
    if (hit !== undefined) return hit;

    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const v of value) copy.push(walk(v, seen));
      return copy;
    }

    if (value instanceof Map) {
      const copy = new Map<unknown, unknown>();
      seen.set(value, copy);
      for (const [k, v] of value) {
        copy.set(walk(k, seen), typeof k === 'string' ? walkProp(k, v, seen) : walk(v, seen));
      }
      return copy;
    }

    if (value instanceof Set) {
      const copy = new Set<unknown>();
      seen.set(value, copy);
      for (const v of value) copy.add(walk(v, seen));
      return copy;
    }

    if (value instanceof Error) {
      // Same prototype (keeps `instanceof VoxError`, code, hint); every own property redacted,
      // including the non-enumerable message, stack and cause. The copy is not a native Error
      // object (util.types.isNativeError is false), which is fine for logs and events.
      const copy = Object.create(Object.getPrototypeOf(value) as object) as Error;
      seen.set(value, copy);
      for (const key of Reflect.ownKeys(value)) {
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) continue;
        // V8 may expose `stack` as an accessor; read it and store a redacted data property.
        const raw: unknown = 'value' in desc ? desc.value : Reflect.get(value, key);
        define(copy, key, walkProp(key, raw, seen), desc.enumerable ?? false);
      }
      return copy;
    }

    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value; // Date, Buffer, URL, …: as is
    const copy: Record<string, unknown> = proto === null ? Object.create(null) : {};
    seen.set(value, copy);
    for (const [k, v] of Object.entries(value)) define(copy, k, walkProp(k, v, seen), true);
    return copy;
  }

  return {
    addSecrets(values) {
      let changed = false;
      for (const v of values) {
        if (typeof v !== 'string' || v.length < MIN_SECRET_LENGTH) continue;
        // raw, URL-encoded and JSON-escaped forms
        for (const form of [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]) {
          if (!secrets.has(form)) {
            secrets.add(form);
            changed = true;
          }
        }
      }
      if (!changed) return;
      // Longest first, so a secret that contains another is removed whole.
      const sorted = [...secrets].sort((a, b) => b.length - a.length);
      literal = new RegExp(sorted.map(escapeRegExp).join('|'), 'g');
    },
    redact<T>(value: T): T {
      try {
        return walk(value, new WeakMap()) as T;
      } catch {
        // e.g. a throwing getter: never let redaction break an error path, never leak the value
        return REDACTED as T;
      }
    },
  };
}

/** The engine-wide redactor (`engine.redactor`). */
export const redactor: Redactor = createRedactor();
