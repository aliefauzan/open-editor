// An editor context for component tests: the real engine behind a fake window.vox.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '@vox/engine';
import { createEditorContext, type EditorContext } from '../../src/renderer/editor/context.tsx';
import type { SettingsData } from '../../src/shared/api.ts';
import type { Project } from '../../src/shared/project.ts';
import { editorProject, tempEngine } from './engine-fixture.ts';
import { fakeVox, type FakeVox } from './fake-vox.ts';

export interface TestEditor {
  engine: Engine;
  project: Project;
  fake: FakeVox;
  ctx: EditorContext;
}

export async function testEditor(
  o: { testStyles?: boolean; handlers?: Parameters<typeof fakeVox>[1] } = {},
): Promise<TestEditor> {
  const engine = tempEngine(o);
  // the engine test styles' `base/title` takes `text`, the repo one `title`
  const project = await editorProject(
    engine,
    o.testStyles ? { titleVariables: { text: 'Hello' } } : {},
  );
  // compile links media files: a placeholder is enough for preview builds
  const media = join(engine.projectsDir, project.id, 'media');
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, 'v.mp4'), Buffer.alloc(1024));
  const fake = fakeVox(engine, o.handlers);
  const ctx = createEditorContext(fake.vox);
  await ctx.editor.getState().open(project.id);
  return { engine, project, fake, ctx };
}

export async function idle(t: TestEditor): Promise<void> {
  await t.ctx.editor.getState().whenIdle();
  await t.fake.settle();
}

/** `settings.get` data: no providers and no roles (so no editor model), with overrides. */
export function settingsData(over: Partial<SettingsData> = {}): SettingsData {
  return {
    providers: [],
    presets: [
      { id: 'openrouter', label: 'OpenRouter', key: 'required', local: false },
      {
        id: 'ollama',
        label: 'Ollama',
        key: 'none',
        baseUrl: 'http://127.0.0.1:11434',
        local: true,
      },
    ],
    roles: {},
    limits: { maxUsdPerRun: 3, maxStepsPerRun: 40 },
    prices: {},
    appleHelper: true,
    probes: [],
    ingest: { cookiesFromBrowser: null },
    contact: null,
    ...over,
  };
}
