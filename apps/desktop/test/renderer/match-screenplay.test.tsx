// @vitest-environment jsdom
// 14b: the "Match screenplay" quick action of the agent panel. Without a screenplay document it asks for
// one (nothing runs); with one in the project it starts the `screenplay` workflow with the document attached.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPanel } from '../../src/renderer/editor/AgentPanel.tsx';
import { EditorProvider } from '../../src/renderer/editor/context.tsx';
import type { SettingsData } from '../../src/shared/api.ts';
import { idle, testEditor } from './ctx.ts';

afterEach(cleanup);

const settings = {
  providers: [],
  presets: [],
  roles: { editor: { providerId: 'ollama', model: 'qwen3.5:latest' } },
  limits: { maxUsdPerRun: 3, maxStepsPerRun: 40 },
  prices: {},
  appleHelper: true,
  probes: [],
  ingest: { cookiesFromBrowser: null },
  contact: null,
} as unknown as SettingsData;

async function panel() {
  const t = await testEditor({
    handlers: {
      'agent.runs': () => [],
      'agent.run': () => ({ runId: 'run_uitest000002', workflow: 'screenplay', mode: 'tools' }),
      'settings.get': () => settings,
    },
  });
  render(
    <EditorProvider value={t.ctx}>
      <AgentPanel />
    </EditorProvider>,
  );
  await idle(t);
  return { t, calls: (m: string) => t.fake.calls.filter((c) => c.method === m) };
}

describe('Match screenplay (14b)', () => {
  it('no screenplay document: asks for one and starts nothing', async () => {
    const { t, calls } = await panel();
    fireEvent.click(screen.getByRole('button', { name: 'Match screenplay' }));
    await waitFor(() => expect(t.ctx.editor.getState().toasts.length).toBe(1));
    expect(JSON.stringify(t.ctx.editor.getState().toasts)).toContain('Drop a screenplay');
    expect(calls('agent.run')).toHaveLength(0);
  });

  it('a screenplay document in the project: starts the screenplay workflow with it attached', async () => {
    const { t, calls } = await panel();
    await t.engine.applyOp(
      t.project.id,
      {
        op: 'addMedia',
        args: {
          media: {
            id: 'm_screenplay1',
            kind: 'document',
            path: 'media/m_screenplay1.fountain',
            textPath: 'media/m_screenplay1.txt',
            origin: { type: 'upload' },
            tags: [],
          },
        },
      },
      { actor: 'user' },
    );
    await t.ctx.editor.getState().reload();
    await idle(t);
    fireEvent.click(screen.getByRole('button', { name: 'Match screenplay' }));
    await waitFor(() => expect(calls('agent.run')).toHaveLength(1));
    expect(calls('agent.run')[0]!.args[0]).toMatchObject({
      projectId: t.project.id,
      workflow: 'screenplay',
      attachments: ['m_screenplay1'],
    });
  });
});
