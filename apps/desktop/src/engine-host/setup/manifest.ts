// The setup manifest: what first-run setup installs, at which pin, with which hash (S16).
// manifest.json is plain data so the build script can read the same pins for the bundled uv.

import { readFileSync } from 'node:fs';
import { SetupError } from './errors.ts';
import type { ArchiveFormat } from './extract.ts';

interface Base {
  id: string;
  label: string;
  licence: string;
  /** Approximate size on disk once installed, shown before the user starts an install. */
  sizeBytesOnDisk: number;
}

/** Pinned release archive: exact version, SHA-256 and byte size. Installed to <tools>/<id>/<version>/. */
export interface ArchiveComponent extends Base {
  kind: 'archive';
  version: string;
  format: ArchiveFormat;
  url: string;
  sha256: string;
  size: number;
  /** Path of the executable inside the archive. */
  binary: string;
}

/** A single binary that updates itself (yt-dlp -U); its hash comes from the release's checksum list. */
export interface BinaryComponent extends Base {
  kind: 'binary';
  version: string;
  url: string;
  sumsUrl: string;
  sumsName: string;
  /** Unused for this kind; present only so tests can build values with the shared shape. */
  sha256?: string;
}

/** `uv sync --frozen --no-editable` of the bundled py/ project (pyenv.ts). */
export interface PyEnvComponent extends Base {
  kind: 'uv-sync';
}

/** Never downloaded by the app (ffmpeg, D-05). */
export interface ExternalComponent extends Base {
  kind: 'external';
}

/** Installed by something else (Chrome via the bundled HyperFrames CLI); wired by phase 09 via a delegate. */
export interface DelegatedComponent extends Base {
  kind: 'delegated';
}

export type Component =
  ArchiveComponent | BinaryComponent | PyEnvComponent | ExternalComponent | DelegatedComponent;

export interface Manifest {
  schema: 'vox-setup-manifest/1';
  components: Component[];
}

const SHA = /^[0-9a-f]{64}$/;

function bad(msg: string): never {
  throw new SetupError('BAD_MANIFEST', msg);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') bad(`${where}: ${key} must be a non-empty string`);
  return v;
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    bad(`${where}: ${key} must be a number`);
  return v;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function relativePath(o: Record<string, unknown>, key: string, where: string): void {
  const v = str(o, key, where);
  if (v.startsWith('/') || v.includes('\\') || v.split('/').some((p) => p === '..' || p === '')) {
    bad(`${where}: ${key} must be a relative path without ..`);
  }
}

function httpsUrl(o: Record<string, unknown>, key: string, where: string): void {
  if (!str(o, key, where).startsWith('https://')) bad(`${where}: ${key} must be an https URL`);
}

export function validateManifest(value: unknown): Manifest {
  if (typeof value !== 'object' || value === null) bad('manifest must be an object');
  const m = value as Record<string, unknown>;
  if (m['schema'] !== 'vox-setup-manifest/1') bad('unsupported manifest schema');
  if (!Array.isArray(m['components'])) bad('components must be an array');
  const seen = new Set<string>();
  for (const raw of m['components'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null) bad('component must be an object');
    const c = raw as Record<string, unknown>;
    const id = str(c, 'id', 'component');
    if (!ID_RE.test(id)) bad(`bad component id ${id}`);
    if (seen.has(id)) bad(`duplicate component id ${id}`);
    seen.add(id);
    str(c, 'label', id);
    str(c, 'licence', id);
    num(c, 'sizeBytesOnDisk', id);
    switch (c['kind']) {
      case 'archive':
        if (!VERSION_RE.test(str(c, 'version', id))) bad(`${id}: bad version`);
        httpsUrl(c, 'url', id);
        if (!SHA.test(str(c, 'sha256', id))) bad(`${id}: sha256 must be 64 lower-case hex digits`);
        num(c, 'size', id);
        relativePath(c, 'binary', id);
        if (c['format'] !== 'tar.gz' && c['format'] !== 'zip')
          bad(`${id}: format must be tar.gz or zip`);
        break;
      case 'binary':
        str(c, 'version', id);
        httpsUrl(c, 'url', id);
        httpsUrl(c, 'sumsUrl', id);
        if (!/^[A-Za-z0-9._-]+$/.test(str(c, 'sumsName', id))) bad(`${id}: bad sumsName`);
        break;
      case 'uv-sync':
      case 'external':
      case 'delegated':
        if (c['kind'] === 'external' && 'url' in c)
          bad(`${id}: an external component has no download URL`);
        break;
      default:
        bad(`${id}: unknown kind`);
    }
  }
  return value as Manifest;
}

export function loadManifest(
  path: string | URL = new URL('./manifest.json', import.meta.url),
): Manifest {
  return validateManifest(JSON.parse(readFileSync(path, 'utf8')));
}
