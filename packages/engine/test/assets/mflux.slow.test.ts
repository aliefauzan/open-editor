// Real mflux (phase 14d): `assets.generate` with the installed model, offline. Needs the model under
// $VOX_TOOLS_DIR/models/mflux/z-image-turbo (install it once with `vox imagegen install`; a missing
// model fails the test, it is not skipped). A dead proxy is set so any network use would fail.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openEngine, resolveToolPaths } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';

const toolsDir =
  process.env['VOX_TOOLS_DIR'] ?? join(homedir(), 'Library/Application Support/Vox Studio/tools');

test('assets generate with the installed Z-Image-Turbo works offline', async () => {
  const manifest = join(toolsDir, 'models/mflux/z-image-turbo/vox-model.json');
  expect(existsSync(manifest), `model missing: run vox imagegen install (${manifest})`).toBe(true);
  process.env['HTTPS_PROXY'] = 'http://127.0.0.1:9';
  process.env['HTTP_PROXY'] = 'http://127.0.0.1:9';
  const e = openEngine({
    projectsDir: join(tempDir('vox-mflux-'), 'Projects'),
    stylesDirs: [],
    templates,
    config: async () => ({}),
    tools: resolveToolPaths({ toolsDir, env: process.env }),
  });
  expect(e.imageProviders.list()).toEqual([{ id: 'mflux' }]);
  const p = await e.createProject('gen');
  const r = (await e.jobs.wait(
    e.jobs.start('assets.generate', {
      projectId: p.id,
      prompt: 'a paper cutout of a green frog on a cream background',
      width: 576,
      height: 1024,
      seed: 3,
    }),
  )) as JobInfo<{ mediaId: string; provider: string }>;
  expect(r.status, JSON.stringify(r.error)).toBe('done');
  const m = (await e.getProject(p.id)).media.find((x) => x.id === r.result?.mediaId);
  expect(m).toMatchObject({ kind: 'image', width: 576, height: 1024 });
  expect(m?.origin).toMatchObject({ type: 'generated', author: 'mflux' });
}, 600_000);
