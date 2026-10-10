// Store fixtures: a project folder in a temp dir and a controllable clock.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore, type StoreOptions } from '../../src/history/store.ts';
import type { HistoryEntry } from '../../src/history/types.ts';
import type { Project } from '../../src/model/schema.ts';
import { richProject } from './project.ts';
import { templates } from './templates.ts';

export interface Clock {
  now: () => Date;
  advance: (ms: number) => void;
}

export function fakeClock(start = Date.parse('2026-10-11T10:00:00.000Z')): Clock {
  let t = start;
  return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

export const tempDir = (prefix = 'vox-store-') => mkdtempSync(join(tmpdir(), prefix));

export async function newStore(
  project: Project = richProject(),
  opts: StoreOptions = {},
): Promise<{ store: ProjectStore; dir: string; clock: Clock }> {
  const clock = fakeClock();
  const dir = join(tempDir(), project.id);
  const store = await ProjectStore.create(dir, project, { templates, now: clock.now, ...opts });
  return { store, dir, clock };
}

export function readEntries(dir: string): HistoryEntry[] {
  return readFileSync(join(dir, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as HistoryEntry);
}

export function readProjectFile(dir: string): Project {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Project;
}

/** A project without the fields every write stamps (version, updatedAt). */
export function content(p: Project): unknown {
  const copy = structuredClone(p) as unknown as Record<string, unknown> & {
    meta: Record<string, unknown>;
  };
  delete copy['version'];
  delete copy.meta['updatedAt'];
  return copy;
}
