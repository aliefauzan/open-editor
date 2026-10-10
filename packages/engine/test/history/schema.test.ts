// C11a: schema safety (plan D-15, R4 S36): SCHEMA_TOO_NEW writes nothing; a migration snapshots first.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ProjectStore } from '../../src/history/store.ts';
import { richProject } from '../helpers/project.ts';
import { tempDir } from '../helpers/store.ts';

function writeProject(raw: unknown, history = ''): string {
  const dir = join(tempDir(), 'p_test');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(raw, null, 2));
  writeFileSync(join(dir, 'history.jsonl'), history);
  return dir;
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = `${statSync(p).mtimeMs}:${readFileSync(p, 'base64')}`;
    }
  };
  walk(dir);
  return out;
}

describe('schema safety', () => {
  test('a newer schemaVersion fails SCHEMA_TOO_NEW and the folder is byte-identical (no lock, log or snapshot)', async () => {
    const raw = { ...richProject(), schemaVersion: 3, futureField: { x: 1 } };
    const dir = writeProject(raw, '{"torn');
    const before = tree(dir);
    await expect(ProjectStore.open(dir)).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
      hint: expect.stringMatching(/update Vox Studio/i),
    });
    expect(tree(dir)).toEqual(before);
  });

  test('a load-time migration writes snapshots/auto-pre-migrate-v1.json first, then migrates and logs', async () => {
    const v2 = richProject();
    const v1 = { ...v2, schemaVersion: 1, name: undefined, title: v2.name };
    const dir = writeProject(v1);
    const original = readFileSync(join(dir, 'project.json'), 'utf8');
    let sawSnapshot = false;
    const store = await ProjectStore.open(dir, {
      migrations: {
        1: (raw) => {
          sawSnapshot = readdirSync(join(dir, 'snapshots')).includes('auto-pre-migrate-v1.json');
          const { title, ...rest } = raw as { title: string };
          return { ...rest, name: title, schemaVersion: 2 };
        },
      },
    });
    expect(sawSnapshot).toBe(true);
    expect(readFileSync(join(dir, 'snapshots/auto-pre-migrate-v1.json'), 'utf8')).toBe(original);
    expect(store.project.name).toBe(v2.name);
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).schemaVersion).toBe(2);
    expect(readFileSync(join(dir, 'logs/engine.log'), 'utf8')).toMatch(
      /migrated project.json from schemaVersion 1 to 2/,
    );
  });

  test('an older schemaVersion without a migration step fails SCHEMA_UNSUPPORTED and writes nothing', async () => {
    const dir = writeProject({ ...richProject(), schemaVersion: 1 });
    const before = tree(dir);
    await expect(ProjectStore.open(dir)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    expect(tree(dir)).toEqual(before);
  });

  test('project.json with unknown fields fails VALIDATION', async () => {
    const dir = writeProject({ ...richProject(), extra: 1 });
    await expect(ProjectStore.open(dir)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
