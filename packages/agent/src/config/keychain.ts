// macOS Keychain access through the `security` command (agent spec "Configuration and keys",
// D-10, R4 S30). A key is written with `security -i` and the `add-generic-password` command on
// stdin, so it is never in any process's argv (visible to `ps`). Reads put only the service and
// account in argv; the key comes back on stdout.
import { spawn } from 'node:child_process';
import { UtilError } from '../errors.pending.ts';
import { parseKeyRef } from './mask.ts';

export const SECURITY_BIN = '/usr/bin/security';
export const DEFAULT_SERVICE = 'Vox Studio';

/** `security` exit code for "item not found". */
const NOT_FOUND = 44;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// printable ASCII only: `security -w` prints a non-ASCII password as hex, which cannot be told from a hex key
const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/;
const REDACTED = '[redacted]';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  signal?: AbortSignal;
}
export type RunProcess = (
  file: string,
  args: readonly string[],
  opts?: RunOptions,
) => Promise<RunResult>;

/** Spawn with an argument array (never a shell, S26), feed stdin, collect output. */
export const runProcess: RunProcess = (file, args, opts = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdin.on('error', () => {
      // the child may exit before reading stdin; the exit code tells the story
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input);
  });

export interface Keychain {
  /** The stored key, or null when there is none. */
  get(providerId: string): Promise<string | null>;
  set(providerId: string, key: string): Promise<void>;
  /** Delete; a missing item is fine. */
  remove(providerId: string): Promise<void>;
}

export interface SecurityKeychainOptions {
  /** Keychain service name; tests use `Vox Studio Test`. */
  service?: string;
  run?: RunProcess;
}

const invalid = (message: string, hint: string): UtilError =>
  new UtilError('CONFIG_INVALID', message, hint);

function checkProviderId(id: string): void {
  if (!PROVIDER_ID.test(id)) {
    throw invalid(
      'provider id is not valid for a Keychain account',
      'Use letters, digits, dot, dash or underscore, starting with a letter or digit.',
    );
  }
}

/** Quote one argument for `security -i`: double quotes, backslash-escaping `\` and `"`. */
const quote = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`;

function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join(REDACTED) : text;
}

export function createSecurityKeychain(options: SecurityKeychainOptions = {}): Keychain {
  const service = options.service ?? DEFAULT_SERVICE;
  if (service === '' || NOT_PRINTABLE_ASCII.test(service))
    throw new Error('invalid Keychain service name');
  const run = options.run ?? runProcess;

  const fail = (what: string, r: RunResult, secret?: string): UtilError =>
    new UtilError(
      'KEYCHAIN_FAILED',
      `Keychain ${what} failed (exit ${String(r.code)})`,
      'Unlock the login Keychain and try again, or use an env: key reference instead.',
      { cause: scrub(r.stderr.trim().split('\n').slice(-3).join('\n'), secret) },
    );

  return {
    async get(providerId) {
      checkProviderId(providerId);
      const r = await run(SECURITY_BIN, [
        'find-generic-password',
        '-s',
        service,
        '-a',
        providerId,
        '-w',
      ]);
      if (r.code === NOT_FOUND) return null;
      if (r.code !== 0) throw fail('read', r);
      return r.stdout.replace(/\r?\n$/, '');
    },

    async set(providerId, key) {
      checkProviderId(providerId);
      if (key === '' || NOT_PRINTABLE_ASCII.test(key)) {
        throw invalid(
          'API key is empty or has characters other than printable ASCII',
          'Paste the key again without line breaks.',
        );
      }
      // One command on one line; a control character in the key could start a second command.
      const command = `add-generic-password -U -s ${quote(service)} -a ${quote(providerId)} -w ${quote(key)}\n`;
      const r = await run(SECURITY_BIN, ['-i'], { input: command });
      if (r.code !== 0) throw fail('write', { ...r, stderr: '' }, key); // stderr may echo the command
    },

    async remove(providerId) {
      checkProviderId(providerId);
      const r = await run(SECURITY_BIN, [
        'delete-generic-password',
        '-s',
        service,
        '-a',
        providerId,
      ]);
      if (r.code !== 0 && r.code !== NOT_FOUND) throw fail('delete', r);
    },
  };
}

export interface ResolveDeps {
  keychain: Keychain;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Turn a stored `apiKey` reference into the key (engine host only). A value that is not a
 * reference is rejected: config never holds a raw key (S17).
 */
export async function resolveApiKey(
  ref: string,
  deps: ResolveDeps,
  /** The config entry the ref belongs to; a `keychain:` ref must name this provider. */
  providerId?: string,
): Promise<string | null> {
  const parsed = parseKeyRef(ref);
  if (!parsed) {
    throw invalid(
      'apiKey must be a reference (keychain:<providerId> or env:NAME), not a key',
      'Save the key through Settings or `vox config providers add`; it goes to the Keychain.',
    );
  }
  if (parsed.kind === 'env') {
    const v = deps.env[parsed.name];
    return v === undefined || v === '' ? null : v;
  }
  if (providerId !== undefined && parsed.providerId !== providerId) {
    throw invalid(
      'a keychain: reference must name the provider it belongs to',
      'Re-enter the key for this provider so it is stored under its own id.',
    );
  }
  return deps.keychain.get(parsed.providerId);
}
