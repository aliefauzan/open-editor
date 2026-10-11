// Phase 15 step 3 (S8): an extracted draft is untrusted. A `build.mjs` placed in the draft itself never
// runs (HOOK_UNTRUSTED, the module is never imported), while `vox/map-route` used through the draft still
// runs its trusted built-in hook. `vox style validate` (static part) passes on the draft; the render
// part, which renders every inherited template's fixtures, is in extract-validate.slow.test.ts.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Project } from '../../src/model/schema.ts';
import { mapDraftStyle } from '../../src/styles/extract/map.ts';
import { writeDraftStyle } from '../../src/styles/extract/write.ts';
import { validateStyle } from '../../src/styles/validate.ts';
import { build, instance, KIT, scene, varsOf } from '../compile/fixture.ts';
import { baseProject, emptySequence, F30, track } from '../helpers/project.ts';
import { mapInput, userStyles } from './extract-fixture.ts';

const MAP_VARS = {
  places: [
    { name: 'Lisbon', lat: 38.72, lon: -9.14 },
    { name: 'Madrid', lat: 40.42, lon: -3.7 },
  ],
  route: true,
  zoom: 'region',
};

function project(template: string, vars: Record<string, unknown>): Project {
  return baseProject(
    {
      ...emptySequence('seq_x', F30),
      styleId: 'ref-look',
      videoTracks: [track('V1', [scene('it_x', template, '1.0.0', 0, 3000, vars)]), track('V2')],
      audioTracks: [track('A1')],
    },
    [],
  );
}

function draft() {
  const s = userStyles();
  const d = mapDraftStyle(mapInput(s.reg()));
  const { dir } = writeDraftStyle(s.dirs, d);
  return { ...s, dir };
}

/** Puts a hook template into the draft by hand (what a tampered or hand-edited draft could hold). */
function plantHook(dir: string): void {
  cpSync(join(KIT, 'kitdraft', 'templates', 'note'), join(dir, 'templates', 'note'), {
    recursive: true,
  });
  const file = join(dir, 'style.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as { templates: string[] };
  json.templates = ['note'];
  writeFileSync(file, JSON.stringify(json));
}

describe('extracted draft: untrusted hooks (S8)', () => {
  test('the draft is untrusted and declares no templates or hooks', () => {
    const s = draft();
    const r = s.reg().get('ref-look');
    expect(r.style.trusted).toBe(false);
    expect(r.style.source).toMatchObject({ type: 'extracted' });
    expect(Object.values(r.templates).filter((t) => t.styleId === 'ref-look')).toEqual([]);
  });

  test('a build.mjs placed in the draft never runs: HOOK_UNTRUSTED, the module is not imported', async () => {
    const s = draft();
    plantHook(s.dir);
    const reg = s.reg();
    const def = reg.template('ref-look/note');
    expect(def?.hookPath).toBeTruthy();
    expect(def?.trusted).toBe(false);
    // the planted build.mjs throws 'untrusted hook ran' on import; HOOK_UNTRUSTED proves it never loaded
    await expect(
      build(project('ref-look/note', { label: 'n' }), { mode: 'render' }, reg),
    ).rejects.toMatchObject({ code: 'HOOK_UNTRUSTED', details: { template: 'ref-look/note' } });
    const v = await validateStyle({
      registry: reg,
      styleId: 'ref-look',
      render: false,
      dom: false,
      kit: false,
    });
    expect(v.notes.join('\n')).toMatch(/ref-look\/note: hook not run \(style not trusted/);
    expect(v.checked['hook-determinism']).toBeUndefined();
  });

  test("vox/map-route through the untrusted draft still runs vox's trusted hook", async () => {
    const s = draft();
    const reg = s.reg();
    expect(reg.template('vox/map-route')?.trusted).toBe(true);
    const b = await build(project('vox/map-route', MAP_VARS), { mode: 'render' }, reg);
    const vars = varsOf(instance(b, 'it_x'), 'it_x');
    expect(vars['routePath']).toMatch(/^M/);
    expect(vars['pins']).toHaveLength(2);
    // the draft's tokens reach the build (re-skin): its display font is linked
    const family = reg.get('ref-look').style.tokens.fonts.display.family;
    expect(b.files.get('index.html') as string).toContain(family);
  });

  test('vox style validate (static part) passes on the draft', async () => {
    const s = draft();
    const v = await validateStyle({
      registry: s.reg(),
      styleId: 'ref-look',
      render: false,
      dom: false,
      kit: false,
    });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });
});
