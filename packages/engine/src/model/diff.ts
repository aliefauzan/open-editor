// Change records (engine spec "Change records"): diff of the normalised before/after views.
import { deepEqual } from './equal.ts';
import { normalise, type Entity, type EntityMap } from './normalise.ts';
import type { Project } from './schema.ts';

export interface Change {
  key: string;
  /** null = created */
  before: Entity | null;
  /** null = deleted */
  after: Entity | null;
}

export function diffMaps(before: EntityMap, after: EntityMap): Change[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const out: Change[] = [];
  for (const key of [...keys].sort()) {
    const b = before.get(key) ?? null;
    const a = after.get(key) ?? null;
    if (!deepEqual(b, a)) out.push({ key, before: b, after: a });
  }
  return out;
}

export function diffProjects(before: Project, after: Project): Change[] {
  return diffMaps(normalise(before), normalise(after));
}
