// Phase 06 step 2 (S8 `migrate` part): a scene placed with an older major version compiles when the
// template's trusted `build.mjs` exports `migrate(variables, fromVersion)`; in an untrusted style the
// hook never runs (HOOK_UNTRUSTED). The plain major-mismatch test is phase 03's (compile.test.ts).
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Project } from '../../src/model/schema.ts';
import { loadStyleRegistry } from '../../src/styles/registry.ts';
import { baseProject, emptySequence, F30, track } from '../helpers/project.ts';
import { build, REPO_STYLES, scene } from './fixture.ts';

const TOOLING = join(import.meta.dirname, '..', 'fixtures', 'styles', 'tooling');

const reg = (trusted: string[]) =>
  loadStyleRegistry({
    stylesDirs: [REPO_STYLES, TOOLING],
    isTrusted: (id) => trusted.includes(id),
  });

function project(styleId: string, template: string, version: string, vars: object): Project {
  return baseProject(
    {
      ...emptySequence('seq_m', F30),
      styleId,
      videoTracks: [
        track('V1', [scene('it_n', template, version, 0, 2000, vars as Record<string, unknown>)]),
      ],
    },
    [],
  );
}

const instanceVars = (html: string) =>
  JSON.parse(/data-vox-instance="it_n">(.*?)<\/script>/s.exec(html)![1]!) as Record<
    string,
    unknown
  >;

describe('TEMPLATE_VERSION migration (step 2, S8)', () => {
  test('a trusted migrate maps 1.x variables to the installed 2.x template', async () => {
    const b = await build(
      project('mig', 'mig/note', '1.3.0', { text: 'Old text' }),
      { mode: 'render' },
      reg(['mig']),
    );
    const vars = instanceVars(b.files.get('scenes/it_n.html') as string);
    expect(vars['label']).toBe('Old text');
    expect(vars).not.toHaveProperty('text');
  });

  test('migrated variables that break the schema fail with VARIABLES_INVALID', async () => {
    await expect(
      build(project('mig', 'mig/note', '1.0.0', { text: 'bad' }), { mode: 'render' }, reg(['mig'])),
    ).rejects.toMatchObject({ code: 'VARIABLES_INVALID' });
  });

  test('a trusted hook without migrate still fails with TEMPLATE_VERSION', async () => {
    await expect(
      build(project('mig', 'mig/nomig', '1.0.0', { label: 'x' }), { mode: 'render' }, reg(['mig'])),
    ).rejects.toMatchObject({
      code: 'TEMPLATE_VERSION',
      details: { placed: '1.0.0', installed: '2.0.0' },
    });
  });

  test('untrusted: the hook (and its migrate) never runs, HOOK_UNTRUSTED', async () => {
    // migdraft/note's build.mjs throws when imported; HOOK_UNTRUSTED proves it was never loaded
    await expect(
      build(
        project('migdraft', 'migdraft/note', '1.0.0', { text: 'x' }),
        { mode: 'render' },
        reg([]),
      ),
    ).rejects.toMatchObject({ code: 'HOOK_UNTRUSTED', details: { template: 'migdraft/note' } });
    // the same template from the trusted-by-id copy is untrusted here too
    await expect(
      build(project('mig', 'mig/note', '1.0.0', { text: 'x' }), { mode: 'render' }, reg([])),
    ).rejects.toMatchObject({ code: 'HOOK_UNTRUSTED' });
  });
});
