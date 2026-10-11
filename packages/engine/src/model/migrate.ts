// Load-time migrations of project.json (engine spec "Write order, crash recovery, locking"; plan
// D-62). Each step takes a raw project at schemaVersion N and returns it at N + 1; the store copies
// project.json to snapshots/auto-pre-migrate-v<N>.json before it runs them.
import type { Migration } from '../history/store.ts';

/**
 * 2 → 3 (v1.1): every v1.1 field is optional and absent means the v1 behaviour (`MediaClip.speed`
 * = 1), so only the number changes.
 */
export const migrate2to3: Migration = (raw) => ({ ...raw, schemaVersion: 3 });

export const MIGRATIONS: Readonly<Record<number, Migration>> = { 2: migrate2to3 };
