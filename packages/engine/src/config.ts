// ~/.vox/config.json: the only reader and writer (engine spec "Library API" → Config; agent spec
// "Configuration and keys"; plan R4 S17). Every package (engine, agent, cli, app) goes through here.
// Writes: lock, read, merge the patch (JSON merge patch), validate, temp file 0600 + fsync + rename.

import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { VoxError } from './errors.pending.ts';

// Agent sections (providers, roles, limits) follow agent spec "Configuration and keys"; phase 11
// tightens them (key refs, baseUrl without credentials). Unknown keys are kept, never dropped.
const ProviderEntry = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const RoleRef = z.looseObject({ providerId: z.string().min(1), model: z.string().min(1) });

export const ConfigSchema = z.looseObject({
  providers: z.array(ProviderEntry).optional(),
  roles: z.record(z.string(), RoleRef).optional(),
  limits: z
    .looseObject({
      maxUsdPerRun: z.number().positive().optional(),
      maxStepsPerRun: z.number().int().positive().optional(),
    })
    .optional(),
  /** Email or URL for the Wikimedia Commons User-Agent (asked once by `vox doctor`). */
  contact: z.string().min(1).max(320).optional(),
  /** Projects folder (D-10: flag > env > config > default). Absolute only. */
  projectsDir: z
    .string()
    .refine((p) => isAbsolute(p), 'projectsDir must be an absolute path')
    .optional(),
  ingest: z
    .looseObject({
      /** S33: set only by the user (Settings or `vox config set`); absent or null = off. */
      cookiesFromBrowser: z.enum(['safari', 'chrome', 'firefox']).nullable().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

type Patch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: Patch<T[K]> | null }
    : T;

/** A JSON merge patch (RFC 7396): objects merge, `null` removes a key, arrays and scalars replace. */
export type ConfigPatch = Patch<Config>;

/** `$VOX_HOME` (tests) or `~/.vox`. */
export function voxHome(): string {
  const env = process.env['VOX_HOME'];
  return env && env.length > 0 ? env : join(homedir(), '.vox');
}

export function configPath(): string {
  return join(voxHome(), 'config.json');
}

function invalid(message: string, details?: Record<string, unknown>): VoxError {
  return new VoxError(
    'CONFIG_INVALID',
    message,
    `Fix ${configPath()} by hand, or delete it to start from defaults`,
    details ? { details } : {},
  );
}

function parseConfig(value: unknown, what: string): Config {
  const res = ConfigSchema.safeParse(value);
  if (!res.success) {
    throw invalid(`${what} is not a valid Vox config`, {
      issues: res.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  return res.data;
}

export async function readConfig(): Promise<Config> {
  let text: string;
  try {
    text = await readFile(configPath(), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw invalid(`${configPath()} cannot be read (${code ?? 'error'})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // No cause: V8's SyntaxError quotes the file text, which may hold secrets (S19).
    throw invalid(`${configPath()} is not valid JSON`);
  }
  return parseConfig(json, configPath());
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** RFC 7396 merge; `undefined` in a patch is ignored; prototype keys are skipped. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k) || v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

// ---- lock: in-process queue + cross-process lock file (O_EXCL, owner token) ----

const LOCK_TIMEOUT_MS = 40_000;
/** A config write takes milliseconds; a lock this old belongs to a hung or dead process. */
const LOCK_STALE_MS = 30_000;
/** A lock file with no readable owner (crash between create and write) is stale after this. */
const LOCK_UNREADABLE_STALE_MS = 2_000;

let queue: Promise<unknown> = Promise.resolve();

interface LockOwner {
  pid?: unknown;
  host?: unknown;
  token?: unknown;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const v = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as LockOwner) : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the stale owner's token ('' when unreadable), or undefined when the lock is live. */
async function staleToken(lockPath: string): Promise<string | undefined> {
  let age: number;
  try {
    age = Date.now() - (await lstat(lockPath)).mtimeMs;
  } catch {
    return undefined; // vanished: just retry
  }
  const owner = await readOwner(lockPath);
  const token = typeof owner?.token === 'string' ? owner.token : '';
  if (owner === undefined) return age > LOCK_UNREADABLE_STALE_MS ? token : undefined;
  if (owner.host === hostname() && typeof owner.pid === 'number' && !pidAlive(owner.pid)) {
    return token;
  }
  return age > LOCK_STALE_MS ? token : undefined;
}

/** Moves a stale lock aside; restores it when someone else's fresh lock was moved instead. */
async function breakStaleLock(lockPath: string, token: string): Promise<void> {
  const aside = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch {
    return; // already gone
  }
  const moved = await readOwner(aside);
  const movedToken = typeof moved?.token === 'string' ? moved.token : '';
  if (movedToken !== token) await link(aside, lockPath).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomUUID();
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx', 0o600);
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token }));
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stale = await staleToken(lockPath);
      if (stale !== undefined) {
        await breakStaleLock(lockPath, stale);
        continue;
      }
      if (Date.now() > deadline) {
        throw new VoxError(
          'CONFIG_LOCKED',
          `Another process has held ${lockPath} for more than ${LOCK_TIMEOUT_MS / 1000} s`,
          `Close other Vox Studio windows or commands and try again; if none run, delete ${lockPath}`,
        );
      }
      await delay(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    // Remove only our own lock (never one that replaced ours after a stale break).
    const owner = await readOwner(lockPath);
    if (owner?.token === token) await unlink(lockPath).catch(() => undefined);
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Mode 0600 from the first byte (S17); the rename replaces any looser pre-existing file.
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  // Durability of the rename only; the write is already committed, so a failure here is ignored.
  try {
    const dir = await open(voxHome(), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // some file systems refuse fsync on a directory
  }
}

/**
 * Merges `patch` into the stored config and returns the result. Keys the patch does not name are
 * kept (S17: another writer's fields are never dropped). Serialised in-process and across processes.
 */
export function writeConfig(patch: ConfigPatch): Promise<Config> {
  const run = queue.then(async () => {
    await mkdir(voxHome(), { recursive: true, mode: 0o700 });
    const path = configPath();
    return withFileLock(`${path}.lock`, async () => {
      const current = await readConfig();
      const next = parseConfig(mergePatch(current, patch), 'The updated config');
      await writeAtomic(path, JSON.stringify(next, null, 2) + '\n');
      return next;
    });
  });
  queue = run.catch(() => undefined);
  return run;
}
