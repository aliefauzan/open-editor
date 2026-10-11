// An editor context for component tests: the real engine behind a fake window.vox.
import type { Engine } from '@vox/engine';
import { createEditorContext, type EditorContext } from '../../src/renderer/editor/context.tsx';
import type { Project } from '../../src/shared/project.ts';
import { editorProject, tempEngine } from './engine-fixture.ts';
import { fakeVox, type FakeVox } from './fake-vox.ts';

export interface TestEditor {
  engine: Engine;
  project: Project;
  fake: FakeVox;
  ctx: EditorContext;
}

export async function testEditor(): Promise<TestEditor> {
  const engine = tempEngine();
  const project = await editorProject(engine);
  const fake = fakeVox(engine);
  const ctx = createEditorContext(fake.vox);
  await ctx.editor.getState().open(project.id);
  return { engine, project, fake, ctx };
}

export async function idle(t: TestEditor): Promise<void> {
  await t.ctx.editor.getState().whenIdle();
  await t.fake.settle();
}
