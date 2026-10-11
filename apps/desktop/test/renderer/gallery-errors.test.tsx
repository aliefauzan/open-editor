// @vitest-environment jsdom
// Steps A5 and A6: the style gallery (styles, badges, detail, "Set as style for this sequence") and
// the error states: offline media (red block + relink), job rows with hint + Retry, JOB_CONFLICT items,
// "Set up" buttons for missing tools, and SCHEMA_TOO_NEW (message, nothing opened, files unchanged).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App.tsx';
import { EditorProvider } from '../../src/renderer/editor/context.tsx';
import { Inspector } from '../../src/renderer/editor/Inspector.tsx';
import { JobsPanel } from '../../src/renderer/editor/JobsPanel.tsx';
import { StyleGallery } from '../../src/renderer/editor/StyleGallery.tsx';
import { SetupNotices } from '../../src/renderer/Setup.tsx';
import { useSetup } from '../../src/renderer/setup-store.ts';
import type { SetupStatusData } from '../../src/shared/api.ts';
import type { Project } from '../../src/shared/project.ts';
import { idle, testEditor } from './ctx.ts';
import { op } from './engine-fixture.ts';
import { fakeVox } from './fake-vox.ts';

afterEach(cleanup);
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe('style gallery (A5)', () => {
  it('lists installed styles with badges; the detail view sets the sequence style (one op)', async () => {
    const t = await testEditor({ testStyles: true });
    t.ctx.ui.getState().set({ galleryOpen: true });
    render(
      <EditorProvider value={t.ctx}>
        <StyleGallery />
      </EditorProvider>,
    );
    const grid = await screen.findByRole('list', { name: 'Installed styles' });
    await waitFor(() =>
      expect(within(grid).getAllByRole('button').length).toBeGreaterThanOrEqual(2),
    );
    const names = within(grid)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    const paper = within(grid).getAllByRole('button')[names.findIndex((n) => /paper/i.test(n))]!;
    fireEvent.click(paper);
    const detail = await screen.findByTestId('style-detail');
    await waitFor(() =>
      expect(within(detail).getByRole('region', { name: 'Templates' })).toBeTruthy(),
    );
    const imgs = detail.querySelectorAll('img');
    expect([...imgs].every((i) => i.getAttribute('src')!.startsWith('vox-media://styles/'))).toBe(
      true,
    );
    const n = (await t.engine.history(t.project.id)).length;
    fireEvent.click(within(detail).getByRole('button', { name: 'Set as style for this sequence' }));
    await waitFor(async () => expect((await t.engine.history(t.project.id)).length).toBe(n + 1));
    await idle(t);
    const p = (await t.engine.getProject(t.project.id)) as unknown as Project;
    expect(p.sequences[0]!.styleId).toBe('paper');
  });
});

describe('error states (A6)', () => {
  it('offline media: listed offline on open; the inspector offers Relink…', async () => {
    const t = await testEditor();
    await op(t.engine, t.project.id, 'addMedia', {
      media: {
        id: 'm_gone',
        kind: 'video',
        path: 'media/gone.mp4',
        durationMs: 5000,
        width: 16,
        height: 9,
        hasAudio: false,
        origin: { type: 'upload' },
        tags: [],
      },
    });
    await op(t.engine, t.project.id, 'placeClip', {
      sequenceId: 'seq_main',
      trackId: 'V1',
      mediaId: 'm_gone',
      startMs: 8000,
      durationMs: 2000,
    });
    const p = (await t.engine.getProject(t.project.id)) as unknown as Project;
    const itemId = p.sequences[0]!.videoTracks[0]!.items.find(
      (i) => i.type === 'media' && i.mediaId === 'm_gone',
    )!.id;
    await t.ctx.editor.getState().open(t.project.id);
    await idle(t);
    expect(t.ctx.editor.getState().offline).toEqual(['m_gone']);
    // the timeline library draws no clips in jsdom (no layout): the red block is checked in the
    // Electron UI test and screenshots; here the inspector shows the offline state
    render(
      <EditorProvider value={t.ctx}>
        <Inspector />
      </EditorProvider>,
    );
    act(() => t.ctx.editor.getState().select(itemId));
    expect(await screen.findByRole('button', { name: 'Relink…' })).toBeTruthy();
    expect(screen.getByText('Offline: the media file is missing')).toBeTruthy();
  });

  it('a failed job keeps its row with the hint and Retry runs it again', async () => {
    const starts: string[] = [];
    const t = await testEditor({
      handlers: {
        'jobs.start': ((kind: string) => {
          starts.push(kind);
          return `job_${starts.length}`;
        }) as never,
        'jobs.get': ((id: string) => ({
          id,
          status: 'failed',
          error: {
            code: 'TOOL_MISSING',
            message: 'ffmpeg is missing',
            hint: 'Open setup and install ffmpeg',
          },
        })) as never,
      },
    });
    render(
      <EditorProvider value={t.ctx}>
        <JobsPanel />
      </EditorProvider>,
    );
    await act(() =>
      t.ctx.jobs.getState().start('render', { projectId: t.project.id }, 'MP4: Main'),
    );
    const row = await screen.findByRole('alert');
    expect(row.textContent).toContain('Open setup and install ffmpeg');
    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(starts).toEqual(['render', 'render']));
  });

  it('JOB_CONFLICT lists the conflicting items (clickable); Retry runs the job on the current state', async () => {
    const starts: unknown[] = [];
    const box: { item?: string } = {};
    const t2 = await testEditor({
      handlers: {
        'jobs.start': ((_k: string, a: unknown) => {
          starts.push(a);
          return 'job_c';
        }) as never,
        'jobs.get': (() => ({
          id: 'job_c',
          status: 'failed',
          error: {
            code: 'JOB_CONFLICT',
            message: 'Job changes entities edited since version 3',
            hint: 'Run the job again on the current project',
            details: { keys: [`item:seq_main/${box.item}`, 'sequence:seq_main'] },
          },
        })) as never,
      },
    });
    const item = t2.project.sequences[0]!.videoTracks[0]!.items[0]!.id;
    box.item = item;
    render(
      <EditorProvider value={t2.ctx}>
        <JobsPanel />
      </EditorProvider>,
    );
    await act(() =>
      t2.ctx.jobs.getState().start('quickClips', { projectId: t2.project.id }, 'Quick clips'),
    );
    const list = await screen.findByRole('list', { name: 'Conflicting items' });
    fireEvent.click(within(list).getByRole('button', { name: item }));
    expect(t2.ctx.editor.getState().selection).toContain(item);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(starts).toHaveLength(2));
  });

  it('missing tools: "Set up" buttons open the setup screen at that component', () => {
    useSetup.setState({
      status: {
        components: [
          {
            id: 'whisper',
            label: 'Whisper model',
            kind: 'model',
            licence: 'MIT',
            sizeBytes: 1,
            state: 'missing',
          },
        ],
        disabledStages: { transcribe: ['whisper'] },
        update: { status: 'disabled' },
      } as unknown as SetupStatusData,
      open: false,
    });
    render(<SetupNotices />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up Whisper model' }));
    expect(useSetup.getState()).toMatchObject({ open: true, focus: 'whisper' });
    useSetup.setState({ open: false, focus: null, status: null });
  });

  it('SCHEMA_TOO_NEW: the message shows, the project does not open, its files stay byte-identical', async () => {
    const t = await testEditor();
    const dir = join(t.engine.projectsDir, t.project.id);
    const pj = join(dir, 'project.json');
    const raw = JSON.parse(readFileSync(pj, 'utf8')) as { schemaVersion: number };
    writeFileSync(pj, JSON.stringify({ ...raw, schemaVersion: raw.schemaVersion + 1 }));
    const snap = () =>
      readdirSync(dir)
        .filter((f) => statSync(join(dir, f)).isFile() && !f.endsWith('.lock'))
        .map((f) => [f, readFileSync(join(dir, f)).toString('base64')]);
    // a new session: a fresh engine sees the file as written
    const { openEngine } = await import('@vox/engine');
    const fresh = openEngine({
      projectsDir: t.engine.projectsDir,
      stylesDirs: [join(dir, '..', '..')],
      trustFile: join(dir, '..', '..', 'trust.json'),
    });
    const fake = fakeVox(fresh);
    const before = snap();
    (window as unknown as { vox: unknown }).vox = fake.vox;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editor' }));
    const msg = await screen.findByTestId('schema-too-new');
    expect(msg.textContent).toBe(
      'This project was made with a newer version of Vox Studio. Update the app to open it.',
    );
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByTestId('quick-start')).toBeTruthy();
    await fake.settle();
    expect(snap()).toEqual(before);
  });
});
