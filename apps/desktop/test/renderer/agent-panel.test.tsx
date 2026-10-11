// @vitest-environment jsdom
// Phase 13 step 2: the agent panel and the Settings dialog. The event stream fills the run card (todos
// with the current item, the tool now running, the "agent editing" tab marker) and the activity log;
// the pause cards answer with `agent.decide` (tighten with the ticked word keys, Skip with none, the
// plan, the budget's "Continue with $X") or `agent.stop`; plan beats and LISTEN timecodes seek; a
// real edit run on the real engine host ends in the log, and "Undo this run" after a user edit shows
// the UNDO_CONFLICT items. Settings: the key is write-only (the canary never reaches the DOM), roles
// are offered only after a passing probe, and "Open Settings" from LOGIN_REQUIRED focuses the
// cookies toggle.
import { join } from 'node:path';
import { setWorkflowsDir } from '@vox/agent';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { CANARY_KEY } from '../../../../packages/agent/test/helpers/canary.ts';
import { configDeps } from '../../../../packages/agent/test/helpers/fakes.ts';
import { dynamicModel, role } from '../../../../packages/agent/test/helpers/workflow.ts';
import { fixtureProject } from '../../../../packages/agent/test/helpers/project.ts';
import { AgentHost } from '../../src/engine-host/agent.ts';
import { createHandlers } from '../../src/engine-host/handlers.ts';
import { AgentPanel } from '../../src/renderer/editor/AgentPanel.tsx';
import { parseTimecode } from '../../src/renderer/editor/agent-store.ts';
import { createEditorContext, EditorProvider } from '../../src/renderer/editor/context.tsx';
import { SequenceTabs } from '../../src/renderer/editor/SequenceTabs.tsx';
import { SettingsDialog } from '../../src/renderer/Settings.tsx';
import type {
  AgentPauseData,
  AgentRunData,
  ProbedData,
  SettingsData,
  SettingsPatchData,
} from '../../src/shared/api.ts';
import { idle, testEditor, type TestEditor } from './ctx.ts';
import { fakeVox } from './fake-vox.ts';

afterEach(cleanup);

// under jsdom the agent's `import.meta.url` is a dev-server path, so point the loader at the repo files
const WORKFLOWS = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'agent',
  'workflows',
);

const RUN = 'run_uitest000001';

function settingsData(over: Partial<SettingsData> = {}): SettingsData {
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

function runRec(projectId: string, over: Partial<AgentRunData> = {}): AgentRunData {
  return {
    runId: RUN,
    projectId,
    workflow: 'edit',
    mode: 'tools',
    message: 'make it tighter',
    models: { editor: 'ollama:qwen3.5:latest' },
    startedAt: '2026-10-12T10:00:00.000Z',
    status: 'running',
    summary: '',
    costUsd: 0,
    steps: [],
    tools: [],
    todos: [],
    scope: [],
    changes: [],
    clips: [],
    sequenceIds: [],
    ...over,
  };
}

/** The panel on the real engine; the agent methods answer from `box` (events come from the test). */
async function panel() {
  const box: { runs: AgentRunData[]; settings: SettingsData } = {
    runs: [],
    settings: settingsData({
      roles: { editor: { providerId: 'ollama', model: 'qwen3.5:latest' } },
      mode: 'plan',
    }),
  };
  const t = await testEditor({
    handlers: {
      'agent.runs': () => structuredClone(box.runs),
      'agent.run': () => ({ runId: RUN, workflow: 'edit', mode: 'tools' }),
      'agent.stop': () => undefined,
      'agent.decide': () => undefined,
      'agent.undoRun': () => undefined,
      'settings.get': () => box.settings,
    },
  });
  render(
    <EditorProvider value={t.ctx}>
      <SequenceTabs />
      <AgentPanel />
    </EditorProvider>,
  );
  await idle(t);
  const seqId = t.project.sequences[0]!.id;
  const itemId = t.project.sequences[0]!.videoTracks[0]!.items[0]!.id;
  const ev = (type: string, payload: Record<string, unknown>) =>
    t.fake.emit('agent.event', { type, payload: { runId: RUN, ...payload } });
  const pause = async (p: Omit<AgentPauseData, 'runId'>) => {
    box.runs = [runRec(t.project.id, { status: 'paused', pause: { runId: RUN, ...p } })];
    ev('agent.paused', p as unknown as Record<string, unknown>);
    await t.fake.settle();
  };
  const calls = (method: string) => t.fake.calls.filter((c) => c.method === method);
  return { t, box, seqId, itemId, ev, pause, calls };
}

async function started(p: Awaited<ReturnType<typeof panel>>) {
  p.box.runs = [runRec(p.t.project.id)];
  p.ev('agent.started', { projectId: p.t.project.id, workflow: 'edit', mode: 'tools' });
  await p.t.fake.settle();
  await screen.findByTestId('agent-run');
}

describe('agent panel (phase 13)', () => {
  it('shows the editor model and mode; confirm plan and the selection go with Cmd+Enter', async () => {
    const p = await panel();
    await waitFor(() =>
      expect(screen.getByTestId('agent-mode').textContent).toBe('qwen3.5:latest · plan'),
    );
    fireEvent.click(screen.getByLabelText('Confirm plan first'));
    const box = screen.getByLabelText('Message to the agent');
    fireEvent.change(box, { target: { value: 'cut the pauses' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(p.calls('agent.run')).toHaveLength(1));
    expect(p.calls('agent.run')[0]!.args[0]).toMatchObject({
      projectId: p.t.project.id,
      message: 'cut the pauses',
      selection: [p.seqId],
      confirmPlan: true,
    });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('streams todos, the running tool and the tab marker; done fills the activity log', async () => {
    const p = await panel();
    await started(p);
    p.ev('agent.step', { step: 1, scope: [p.seqId], summary: '' });
    p.t.fake.emit('agent.todos', {
      runId: RUN,
      items: [
        { text: 'Cut the pauses', status: 'in_progress' },
        { text: 'Check the cut', status: 'pending' },
      ],
    });
    p.ev('agent.tool', { callId: 'c1', tool: 'get_transcript', status: 'started' });
    await p.t.fake.settle();
    await waitFor(() => expect(screen.getByTestId('agent-editing')).toBeTruthy());
    const todos = screen.getByTestId('agent-todos');
    expect(
      within(todos)
        .getByText(/Cut the pauses/)
        .getAttribute('aria-current'),
    ).toBe('step');
    expect(
      within(todos)
        .getByText(/Check the cut/)
        .getAttribute('data-status'),
    ).toBe('pending');
    expect(screen.getByTestId('agent-run').textContent).toContain('get_transcript');

    p.box.runs = [
      runRec(p.t.project.id, {
        status: 'completed',
        summary: 'Cut two pauses.',
        steps: [{ step: 1, scope: [p.seqId], text: 'Looking at the transcript' }],
        tools: [{ tool: 'trim_item', status: 'done' }],
        changes: [
          {
            version: 3,
            op: 'trimItem',
            itemIds: [p.itemId],
            sequenceIds: [p.seqId],
            undone: false,
          },
        ],
      }),
    ];
    p.ev('agent.done', { status: 'completed', summary: 'Cut two pauses.', costUsd: 0 });
    await p.t.fake.settle();
    await waitFor(() =>
      expect(screen.getByTestId('agent-run').getAttribute('data-status')).toBe('completed'),
    );
    expect(screen.queryByTestId('agent-editing')).toBeNull();
    const log = screen.getByTestId('activity-log');
    expect(log.textContent).toContain('Edited in timeline (1 change)');
    expect(log.textContent).toContain('Cut two pauses.');
    fireEvent.click(within(log).getByRole('button', { name: /v3 trimItem/ }));
    expect(p.t.ctx.editor.getState().selection).toEqual([p.itemId]);
    fireEvent.click(within(log).getByRole('button', { name: 'Undo this run' }));
    await waitFor(() => expect(p.calls('agent.undoRun')).toHaveLength(1));
  });

  it('tighten pause: a range seeks, Apply sends the ticked word keys, Skip sends none', async () => {
    const p = await panel();
    await started(p);
    const tighten = {
      reason: 'approval' as const,
      kind: 'pauses' as const,
      detail: 'Cut 2 pauses and fillers?',
      sequenceId: p.seqId,
      ranges: [
        { wordKey: 'w1', kind: 'pause' as const, seqStartMs: 1200, seqEndMs: 1900, text: '' },
        { wordKey: 'w2', kind: 'filler' as const, seqStartMs: 3000, seqEndMs: 3300, text: 'um' },
      ],
    };
    await p.pause(tighten);
    const card = await screen.findByTestId('pause-tighten');
    const boxes = within(card).getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, true]);
    fireEvent.click(boxes[1]!);
    fireEvent.click(within(card).getAllByRole('button')[0]!);
    expect(p.t.ctx.editor.getState().playheadMs).toBe(1200);
    fireEvent.click(within(card).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(p.calls('agent.decide')).toHaveLength(1));
    expect(p.calls('agent.decide')[0]!.args).toEqual([RUN, { approve: true, wordKeys: ['w1'] }]);

    await p.pause(tighten);
    fireEvent.click(
      within(await screen.findByTestId('pause-tighten')).getByRole('button', { name: 'Skip' }),
    );
    await waitFor(() => expect(p.calls('agent.decide')).toHaveLength(2));
    expect(p.calls('agent.decide')[1]!.args).toEqual([RUN, { approve: true, wordKeys: [] }]);
  });

  it('source, plan and budget pauses: Allow, a beat seeks, Run plan, Continue with $6, Stop', async () => {
    const p = await panel();
    await started(p);
    await p.pause({
      reason: 'approval',
      kind: 'source',
      detail: 'ingest',
      sources: ['https://example.test/broll.mp4'],
    });
    const source = await screen.findByTestId('pause-source');
    expect(source.textContent).toContain('https://example.test/broll.mp4');
    fireEvent.click(within(source).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(p.calls('agent.decide')).toHaveLength(1));
    expect(p.calls('agent.decide')[0]!.args).toEqual([RUN, { approve: true }]);

    await p.pause({
      reason: 'approval',
      kind: 'plan',
      detail: 'plan',
      plan: {
        sequences: [
          {
            sequenceId: p.seqId,
            beats: [
              { startMs: 0, endMs: 2000, kind: 'speaker' },
              {
                startMs: 2000,
                endMs: 4000,
                kind: 'scene',
                template: 'vox/kinetic-serif',
                variables: { text: 'A short clip' },
              },
            ],
          },
        ],
      },
    });
    const plan = await screen.findByTestId('pause-plan');
    expect(plan.textContent).toContain('vox/kinetic-serif');
    expect(plan.textContent).toContain('A short clip');
    const beats = within(plan).getAllByRole('listitem');
    fireEvent.click(within(beats[1]!).getByRole('button'));
    expect(p.t.ctx.editor.getState().playheadMs).toBe(2000);
    fireEvent.click(within(plan).getByRole('button', { name: 'Run plan' }));
    await waitFor(() => expect(p.calls('agent.decide')).toHaveLength(2));

    await p.pause({
      reason: 'budget',
      detail: 'The run used $3.01 of its $3 cap.',
      continueUsd: 6,
    });
    const budget = await screen.findByTestId('pause-budget');
    const go = within(budget).getByRole('button', { name: /^Continue with/ });
    expect(go.textContent).toMatch(/\$6(\.00)?$/);
    fireEvent.click(within(budget).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(p.calls('agent.stop')).toHaveLength(1));
    expect(p.calls('agent.stop')[0]!.args).toEqual([RUN]);
  });

  it('a clip report shows the audio numbers and its LISTEN timecodes seek', async () => {
    expect(parseTimecode('00:12.345')).toBe(12_345);
    expect(parseTimecode('1:02.5')).toBe(62_500);
    expect(parseTimecode('640 ms')).toBe(640);
    expect(parseTimecode('soon')).toBeUndefined();
    const p = await panel();
    p.box.runs = [
      runRec(p.t.project.id, {
        workflow: 'clipper',
        status: 'completed',
        clips: [
          {
            sequenceId: p.seqId,
            status: 'ok',
            scenes: 2,
            placeholders: 0,
            speakerShare: 0.6,
            health: [],
            audio: {
              pass: false,
              failing: ['truePeak'],
              integratedLufs: -14.2,
              truePeakDbtp: -0.4,
              listen: ['00:01.500'],
            },
            edges: [],
            skipped: [],
          },
        ],
      }),
    ];
    await act(() => p.t.ctx.agent.getState().refresh());
    fireEvent.click(screen.getByRole('button', { name: /make it tighter/ }));
    const report = await screen.findByTestId('clip-report');
    expect(screen.getByTestId('audio-numbers').textContent).toContain('-14.2 LUFS');
    expect(screen.getByTestId('audio-numbers').textContent).toContain('failed (truePeak)');
    fireEvent.click(within(report).getByRole('button', { name: '00:01.500' }));
    expect(p.t.ctx.editor.getState().playheadMs).toBe(1500);
  });

  it('no editor model: the panel links to Settings', async () => {
    const p = await panel();
    p.box.settings = settingsData();
    await act(() => p.t.ctx.agent.getState().loadSettings());
    expect(screen.getByTestId('agent-mode').textContent).toBe('no model');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(p.t.ctx.ui.getState().settingsOpen).toBe(true);
  });
});

describe('agent panel on the real engine host (phase 13)', () => {
  it('an edit run lands in the activity log; Undo this run after a user edit lists the items', async () => {
    setWorkflowsDir(WORKFLOWS);
    onTestFinished(() => setWorkflowsDir(undefined));
    const f = await fixtureProject();
    const scripted = dynamicModel(
      (_o, n) =>
        [
          {
            calls: [
              {
                name: 'trim_item',
                input: { sequenceId: 's1', itemId: 'c1', edge: 'end', toMs: 12000 },
              },
            ],
          },
          { text: 'Trimmed the clip.' },
        ][n] ?? { text: 'Done.' },
    );
    const box: { emit?: (n: never, p: unknown) => void } = {};
    const agent = new AgentHost({
      engine: f.engine,
      cfg: configDeps(),
      emit: (n, p) => box.emit?.(n as never, p),
      models: () => Promise.resolve({ models: { editor: role(scripted.model) } }),
      newRunId: () => RUN,
    });
    const host = createHandlers(f.engine, undefined, { agent });
    const pick = (m: keyof typeof host) => host[m]!;
    const fake = fakeVox(f.engine, {
      'agent.run': pick('agent.run'),
      'agent.runs': pick('agent.runs'),
      'agent.stop': pick('agent.stop'),
      'agent.decide': pick('agent.decide'),
      'agent.undoRun': pick('agent.undoRun'),
      'settings.get': () => settingsData(),
    });
    box.emit = fake.emit as never;
    const ctx = createEditorContext(fake.vox);
    await ctx.editor.getState().open(f.projectId);
    ctx.editor.getState().setSequence(f.sequenceId);
    ctx.editor.getState().setSelection([f.v1]);
    const t: TestEditor = { engine: f.engine, project: ctx.editor.getState().project!, fake, ctx };
    render(
      <EditorProvider value={ctx}>
        <AgentPanel />
      </EditorProvider>,
    );
    await idle(t);
    fireEvent.change(screen.getByLabelText('Message to the agent'), {
      target: { value: 'make this shorter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(
      () => expect(screen.getByTestId('agent-run').getAttribute('data-status')).toBe('completed'),
      { timeout: 30_000 },
    );
    await agent.idle();
    await act(() => ctx.agent.getState().refresh());
    // the run ended before its card mounted, so the card starts closed
    const head = screen.getByRole('button', { name: /make this shorter/ });
    if (head.getAttribute('aria-expanded') === 'false') fireEvent.click(head);
    const log = await screen.findByTestId('activity-log');
    expect(log.textContent).toContain('Edited in timeline (1 change)');
    expect(log.textContent).toContain('Trimmed the clip.');
    await f.engine.applyOp(
      f.projectId,
      {
        op: 'trimItem',
        args: { sequenceId: f.sequenceId, itemId: f.v1, edge: 'end', toMs: 11000 },
      },
      { actor: 'user' },
    );
    fireEvent.click(within(log).getByRole('button', { name: 'Undo this run' }));
    const conflict = await screen.findByTestId('undo-conflict');
    fireEvent.click(within(conflict).getByRole('button', { name: f.v1 }));
    expect(ctx.editor.getState().selection).toEqual([f.v1]);
  }, 60_000);
});

describe('Settings dialog (phase 13)', () => {
  function dialog(o: { focus?: 'cookies'; probe?: ProbedData; onClose?: () => void } = {}) {
    const box = {
      settings: settingsData({
        providers: [
          {
            id: 'openrouter',
            type: 'openrouter',
            preset: 'openrouter',
            keyRef: 'none',
            keyMasked: null,
            local: false,
            models: [],
          },
          {
            id: 'ollama',
            type: 'ollama',
            preset: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            keyRef: 'none',
            keyMasked: null,
            local: true,
            models: ['qwen3.5:latest'],
          },
        ],
      }),
      saved: [] as SettingsPatchData[],
    };
    return (async () => {
      const t = await testEditor({
        handlers: {
          'settings.get': () => box.settings,
          'settings.save': (patch: never) => {
            const p = patch as SettingsPatchData;
            box.saved.push(p);
            if (p.provider?.apiKey) {
              box.settings.providers[0] = {
                ...box.settings.providers[0]!,
                keyRef: 'keychain',
                keyMasked: 'sk-or-…anry',
              };
            }
            if (p.role) {
              box.settings.roles = {
                ...box.settings.roles,
                [p.role.role]: { providerId: p.role.providerId, model: p.role.model },
              };
            }
            if (p.cookiesFromBrowser !== undefined)
              box.settings.ingest = { cookiesFromBrowser: p.cookiesFromBrowser };
            return box.settings;
          },
          'settings.probe': () => {
            if (o.probe) box.settings.probes = [o.probe];
            return o.probe;
          },
          'setup.status': () => {
            throw { code: 'NOT_AVAILABLE', message: 'no setup in this test', hint: '' };
          },
        },
      });
      const view = render(
        <EditorProvider value={t.ctx}>
          <SettingsDialog onClose={o.onClose ?? (() => undefined)} focus={o.focus ?? null} />
        </EditorProvider>,
      );
      await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
      return { t, box, view };
    })();
  }

  it('the key is write-only: saved to the host, shown only masked, never in the DOM', async () => {
    const { box, view } = await dialog();
    const input = screen.getByLabelText('API key for OpenRouter') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: CANARY_KEY } });
    fireEvent.click(within(input.closest('form')!).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(box.saved).toHaveLength(1));
    expect(box.saved[0]).toEqual({ provider: { id: 'openrouter', apiKey: CANARY_KEY } });
    await waitFor(() => expect(input.value).toBe(''));
    expect(input.placeholder).toBe('sk-or-…anry');
    expect(view.container.innerHTML).not.toContain(CANARY_KEY);
    expect(screen.getAllByTestId('data-note')[0]!.textContent).toContain('is sent to OpenRouter');
    expect(screen.getAllByTestId('data-note')[1]!.textContent).toContain('stays here');
  });

  it('roles only after a passing probe; badges show each check', async () => {
    const probe: ProbedData = {
      providerId: 'ollama',
      model: 'qwen3.5:latest',
      report: {
        tools: { status: 'pass' },
        loop: { status: 'fail', reason: 'no second step' },
        plan: { status: 'pass' },
      },
      roles: [
        { role: 'editor', assignable: true, mode: 'plan', failures: [] },
        { role: 'fast', assignable: true, failures: [] },
        {
          role: 'vision',
          assignable: false,
          failures: [{ check: 'vision', reason: 'not probed' }],
        },
      ],
    };
    const { box } = await dialog({ probe });
    const row = screen
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('data-provider') === 'ollama')!;
    expect(within(row).queryByRole('button', { name: 'Use as editor' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Test' }));
    const editor = await within(row).findByRole('button', { name: 'Use as editor' });
    expect(row.querySelector('[data-check="loop"]')?.getAttribute('data-status')).toBe('fail');
    expect(row.querySelector('[data-check="plan"]')?.getAttribute('data-status')).toBe('pass');
    expect(
      (within(row).getByRole('button', { name: 'Use as vision' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(editor);
    await waitFor(() =>
      expect(box.saved.at(-1)).toEqual({
        role: { role: 'editor', providerId: 'ollama', model: 'qwen3.5:latest' },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole('listitem').find((li) => li.getAttribute('data-role') === 'editor')!
          .textContent,
      ).toContain('qwen3.5:latest'),
    );
  });

  it('Escape closes the dialog wherever the focus is', async () => {
    let closed = 0;
    await dialog({ onClose: () => closed++ });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toBe(1);
  });

  it('opened for LOGIN_REQUIRED: the cookies toggle has focus and is off; turning it on saves', async () => {
    const { box } = await dialog({ focus: 'cookies' });
    const toggle = document.getElementById('cookies-toggle') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(box.saved.at(-1)).toEqual({ cookiesFromBrowser: 'safari' }));
    expect((await screen.findByLabelText('Cookies browser')) as HTMLSelectElement).toBeTruthy();
  });
});
