// Load-time migration 2 → 3 (engine spec "Clip speed", "Write order, crash recovery, locking";
// plan D-62): only the number changes, the store copies the v2 file first, history recorded under
// v2 still undoes, and a v2 snapshot restores.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ProjectStore } from '../../src/history/store.ts';
import { MIGRATIONS, migrate2to3 } from '../../src/model/migrate.ts';
import { SCHEMA_VERSION } from '../../src/model/schema.ts';
import { richProject } from '../helpers/project.ts';
import { newStore, readProjectFile } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';

const S = 'seq_1';
const rename = (name: string) => ({ op: 'updateSequence', args: { sequenceId: S, name } });
const asV2 = (raw: object) => ({ ...raw, schemaVersion: 2 });

describe('migration 2 → 3', () => {
  test('changes only schemaVersion and leaves its input alone', () => {
    const v2 = asV2(richProject()) as unknown as Record<string, unknown>;
    const before = structuredClone(v2);
    const v3 = migrate2to3(v2);
    expect(v2).toEqual(before);
    expect(v3).toEqual({ ...before, schemaVersion: 3 });
    expect(MIGRATIONS[2]).toBe(migrate2to3);
    expect(SCHEMA_VERSION).toBe(3);
  });

  test('a v2 project opens: pre-migrate copy first, v3 on disk, log line, history still undoes', async () => {
    const { store, dir } = await newStore(richProject(), {});
    await store.apply(rename('edited under v2'), { actor: 'user' });
    const v2Text = JSON.stringify(asV2(readProjectFile(dir)), null, 2);
    writeFileSync(join(dir, 'project.json'), v2Text);

    const reopened = await ProjectStore.open(dir, { templates });
    expect(readFileSync(join(dir, 'snapshots/auto-pre-migrate-v2.json'), 'utf8')).toBe(v2Text);
    const onDisk = readProjectFile(dir);
    expect(onDisk.schemaVersion).toBe(3);
    expect({ ...onDisk, schemaVersion: 2 }).toEqual(JSON.parse(v2Text));
    expect(readFileSync(join(dir, 'logs/engine.log'), 'utf8')).toMatch(
      /migrated project.json from schemaVersion 2 to 3/,
    );
    expect(reopened.project.sequences[0]!.name).toBe('edited under v2');
    await reopened.undo({ actor: 'user' });
    expect(reopened.project.sequences[0]!.name).toBe(richProject().sequences[0]!.name);
    expect(readProjectFile(dir).schemaVersion).toBe(3);
  });

  test('a v2 snapshot restores into a v3 project', async () => {
    const { store, dir } = await newStore(richProject(), {});
    mkdirSync(join(dir, 'snapshots'), { recursive: true });
    const old = asV2({ ...richProject(), name: 'from v1.0' });
    writeFileSync(join(dir, 'snapshots/from-v1.json'), JSON.stringify(old));
    await store.apply({ op: 'restoreSnapshot', args: { name: 'from-v1' } }, { actor: 'user' });
    expect(store.project.schemaVersion).toBe(3);
    expect(readProjectFile(dir).schemaVersion).toBe(3);
  });
});
