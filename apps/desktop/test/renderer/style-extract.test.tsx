// @vitest-environment jsdom
// Phase 15 step 5: "New style from reference video" in the style gallery, against the real engine with
// the test-build extraction (fixture measurements, mock vision model): a link starts one
// `style.extract` job, the report shows in a sandboxed frame, Accept opens the style's detail view and
// "Set as style for this sequence" is one op; Discard removes the draft.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { registerStyleExtract } from '@vox/agent';
import { openEngine, type Engine } from '@vox/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { e2eStyleSteps, e2eVisionRole } from '../../src/engine-host/e2e-style.ts';
import { createHandlers } from '../../src/engine-host/handlers.ts';
import { AgentPanel } from '../../src/renderer/editor/AgentPanel.tsx';
import { createEditorContext, EditorProvider } from '../../src/renderer/editor/context.tsx';
import { StyleGallery } from '../../src/renderer/editor/StyleGallery.tsx';
import { STYLES } from '../helpers/app.ts';
import { editorProject } from './engine-fixture.ts';
import { fakeVox } from './fake-vox.ts';

const FIXTURES = join(STYLES, '..', 'packages', 'engine', 'test', 'fixtures');

afterEach(cleanup);

async function setup(): Promise<{
  engine: Engine;
  user: string;
  ctx: ReturnType<typeof createEditorContext>;
  projectId: string;
}> {
  const home = mkdtempSync(join(tmpdir(), 'vox-sx-'));
  const user = join(home, 'styles');
  mkdirSync(user);
  const engine = openEngine({
    projectsDir: join(home, 'Projects'),
    stylesDirs: [STYLES, user],
    trustFile: join(home, 'trust.json'),
  });
  registerStyleExtract(
    engine,
    { vision: () => Promise.resolve(e2eVisionRole()) },
    e2eStyleSteps(FIXTURES),
  );
  const project = await editorProject(engine);
  const extract = createHandlers(engine, undefined, { styleExtract: { render: false } })[
    'styles.extract'
  ];
  const fake = fakeVox(engine, { 'styles.extract': extract as never });
  const ctx = createEditorContext(fake.vox);
  await ctx.editor.getState().open(project.id);
  return { engine, user, ctx, projectId: project.id };
}

async function extractFromLink(name: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Style name' }), {
    target: { value: name },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Reference video link' }), {
    target: { value: 'https://example.com/reference.mp4' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Extract from link' }));
  return waitFor(
    () => {
      const region = screen.getByRole('region', { name: 'New style from reference video' });
      const alert = within(region).queryByRole('alert');
      if (alert) throw new Error(`extraction failed: ${alert.textContent}`);
      return screen.getByTestId('extract-result');
    },
    { timeout: 60_000 },
  );
}

describe('style gallery: new style from reference video (phase 15)', () => {
  it('the agent panel action opens it; extract, report, accept, set as sequence style', async () => {
    const t = await setup();
    render(
      <EditorProvider value={t.ctx}>
        <AgentPanel />
        <StyleGallery />
      </EditorProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Extract style' }));
    expect(screen.getByRole('region', { name: 'New style from reference video' })).toBeTruthy();
    const result = await extractFromLink('My Ref');
    const frame = within(result).getByTitle('Style report');
    expect(frame.getAttribute('src')).toBe('vox-media://styles/my-ref/report.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(existsSync(join(t.user, 'my-ref', 'report.html'))).toBe(true);
    expect(within(result).getByText(/copies no footage/)).toBeTruthy();
    fireEvent.click(within(result).getByRole('button', { name: 'Accept style' }));
    const detail = await screen.findByTestId('style-detail');
    await waitFor(() => expect(within(detail).getByText('My Ref')).toBeTruthy());
    fireEvent.click(within(detail).getByRole('button', { name: 'Set as style for this sequence' }));
    await waitFor(async () => {
      const p = await t.engine.getProject(t.projectId);
      expect(p.sequences.find((s) => s.id === 'seq_main')?.styleId).toBe('my-ref');
    });
  }, 90_000);

  it('Discard removes the draft', async () => {
    const t = await setup();
    t.ctx.ui.getState().set({ galleryOpen: true, galleryExtract: true });
    render(
      <EditorProvider value={t.ctx}>
        <StyleGallery />
      </EditorProvider>,
    );
    const result = await extractFromLink('Gone Ref');
    expect(existsSync(join(t.user, 'gone-ref'))).toBe(true);
    fireEvent.click(within(result).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(existsSync(join(t.user, 'gone-ref'))).toBe(false));
    expect(t.ctx.ui.getState().galleryExtract).toBe(false);
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Installed styles' })).queryByText('Gone Ref'),
      ).toBeNull(),
    );
  }, 90_000);
});
