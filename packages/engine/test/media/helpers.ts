// Shared helpers for the media and export tests: temp folders, VoxError code capture, fixture paths.

import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxError } from '../../src/errors.ts';

const fx = new URL('../fixtures/', import.meta.url);

/** Absolute path of a file under `packages/engine/test/fixtures/`. */
export function fixture(p: string): string {
  return fileURLToPath(new URL(p, fx));
}

/** A fresh temp folder (realpath, so macOS `/var` → `/private/var` never confuses a path check). */
export function tempDir(prefix = 'vox-media-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** The VoxError code a promise rejects with, or 'OK'. Non-VoxErrors are rethrown. */
export async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VoxError) return e.code;
    throw e;
  }
  return 'OK';
}

/** The VoxError code a function throws, or 'OK'. Non-VoxErrors are rethrown. */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof VoxError) return e.code;
    throw e;
  }
  return 'OK';
}
