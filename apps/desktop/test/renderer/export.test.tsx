// @vitest-environment jsdom
// Step A4: the export dialog — subtitles burned in or not, "Save to" (default = last folder, file and
// folder modes, cancel keeps the old target), the loudness target sent to `render` and `audioQa`
// (D-15), the audio check panel (a FAIL warns without blocking; a listen timecode seeks the preview),
// progress and "Show in Finder" for each written path. Main-only methods are stubbed (as main answers).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorProvider } from '../../src/renderer/editor/context.tsx';
import {
  ExportDialog,
  checkNumbers,
  projectFileUrl,
} from '../../src/renderer/editor/ExportDialog.tsx';
import { idle, testEditor, type TestEditor } from './ctx.ts';
import { op } from './engine-fixture.ts';

afterEach(cleanup);

const FAIL_QA = {
  mode: 'mix',
  pass: false,
  checks: [
    {
      id: 'loudness',
      status: 'fail',
      rule: 'r',
      integratedLufs: -20.1,
      targetLufs: -14,
      deltaLu: -6.1,
      toleranceLu: 1,
    },
    { id: 'spacing', status: 'pass', rule: 'r' },
  ],
  listen: [{ atMs: 2500, kind: 'loud SFX', listenFor: 'harshness' }],
};

interface Stubs {
  jobs: { kind: string; args: Record<string, unknown> }[];
  choose: unknown[];
  answers: (unknown | null)[];
  revealed: string[];
}

async function setup(): Promise<{ t: TestEditor; s: Stubs }> {
  const s: Stubs = { jobs: [], choose: [], answers: [], revealed: [] };
  let tid = 0;
  const t = await testEditor({
    handlers: {
      'exports.lastFolder': (() => ({ targetId: 't_last', displayPath: '~/Movies' })) as never,
      'exports.chooseTarget': ((a: unknown) => {
        s.choose.push(a);
        const ans = s.answers.shift();
        return ans === undefined ? null : ans;
      }) as never,
      'exports.reveal': ((p: string) => {
        s.revealed.push(p);
        return null;
      }) as never,
      'jobs.start': ((kind: string, args: Record<string, unknown>) => {
        s.jobs.push({ kind, args });
        return `job_${kind}_${++tid}`;
      }) as never,
      'jobs.get': ((id: string) => {
        const kind = id.split('_')[1];
        const result =
          kind === 'audioQa'
            ? { ...FAIL_QA, png: '/x/Projects/PID/renders/qa/seq_main/qa.png' }
            : kind === 'render'
              ? {
                  files: [
                    { sequenceId: 'seq_main', path: '/out/Editor - Main.mp4', durationMs: 8000 },
                  ],
                }
              : { path: `/out/Editor - Main.${kind === 'exportCaptions' ? 'srt' : 'otio'}` };
        return { id, status: 'done', progress: 1, result };
      }) as never,
    },
  });
  await op(t.engine, t.project.id, 'setCaptions', { sequenceId: 'seq_main', enabled: true });
  await t.ctx.editor.getState().reload();
  await idle(t);
  t.ctx.ui.getState().set({ exportOpen: true });
  render(
    <EditorProvider value={t.ctx}>
      <ExportDialog />
    </EditorProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('save-to').textContent).toContain('~/Movies'));
  return { t, s };
}

const dialog = () => screen.getByRole('dialog', { name: 'Export' });
const exportBtn = () => within(dialog()).getByRole('button', { name: /^Export \d+ files?$/ });

describe('export dialog (A4)', () => {
  it('MP4 + SRT go to the last folder; burn-in, loudness and the targetId reach render and audioQa', async () => {
    const { t, s } = await setup();
    fireEvent.change(screen.getByLabelText('Loudness target'), { target: { value: 'tiktok' } });
    fireEvent.click(exportBtn());
    await waitFor(() =>
      expect(s.jobs.map((j) => j.kind)).toEqual(['audioQa', 'render', 'exportCaptions']),
    );
    expect(s.jobs[0]!.args).toEqual({
      projectId: t.project.id,
      sequenceId: 'seq_main',
      loudness: 'tiktok',
    });
    expect(s.jobs[1]!.args).toMatchObject({
      sequenceId: 'seq_main',
      captions: 'burn',
      loudness: 'tiktok',
      quality: 'standard',
      targetId: 't_last',
    });
    expect(s.jobs[2]!.args).toMatchObject({ format: 'srt', targetId: 't_last' });
    // nothing carries a raw path
    expect(JSON.stringify(s.jobs)).not.toMatch(/"(path|file|dir|target)"/);
  });

  it('subtitles not burned in → captions: none', async () => {
    const { s } = await setup();
    fireEvent.click(screen.getByLabelText('Subtitles burned in'));
    fireEvent.click(exportBtn());
    await waitFor(() =>
      expect(s.jobs.find((j) => j.kind === 'render')?.args.captions).toBe('none'),
    );
  });

  it('Save to: one file → file mode with the name prefilled; several → folder; cancel keeps the old target', async () => {
    const { s } = await setup();
    // MP4 + SRT = 2 files → folder picker
    s.answers.push({ targetId: 't_dir', displayPath: '~/Clips' });
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    await waitFor(() => expect(screen.getByTestId('save-to').textContent).toContain('~/Clips'));
    expect(s.choose[0]).toMatchObject({ mode: 'folder' });
    // cancel (null) keeps ~/Clips
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    await waitFor(() => expect(s.choose).toHaveLength(2));
    expect(screen.getByTestId('save-to').textContent).toContain('~/Clips');
    // only MP4 = 1 file → save dialog with "<project> - <sequence>.mp4"
    fireEvent.click(screen.getByLabelText('SRT captions'));
    s.answers.push({ targetId: 't_file', displayPath: '~/Clips/a.mp4' });
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    await waitFor(() => expect(screen.getByTestId('save-to').textContent).toContain('a.mp4'));
    expect(s.choose[2]).toMatchObject({
      mode: 'file',
      format: 'mp4',
      suggestedName: 'Editor - Main.mp4',
    });
    // adding a second file again drops the file target for the remembered folder
    fireEvent.click(screen.getByLabelText('SRT captions'));
    await waitFor(() => expect(screen.getByTestId('save-to').textContent).toContain('~/Movies'));
  });

  it('audio check: a FAIL warns but the export still runs; a listen button seeks the preview', async () => {
    const { t, s } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Check audio' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Some audio checks failed');
    const panel = screen.getByRole('region', { name: 'Audio check' });
    expect(panel.textContent).toContain('FAIL');
    expect(panel.textContent).toContain('integratedLufs -20.1');
    fireEvent.click(within(panel).getByRole('button', { name: 'Listen 2.50 s' }));
    expect(t.ctx.editor.getState().playheadMs).toBe(2500);
    fireEvent.click(exportBtn());
    await waitFor(() => expect(s.jobs.some((j) => j.kind === 'render')).toBe(true));
  });

  it('progress rows reveal each written path in Finder (exports.reveal)', async () => {
    const { s } = await setup();
    fireEvent.click(screen.getByLabelText('Editable timeline (OTIO)'));
    fireEvent.click(exportBtn());
    const list = await screen.findByRole('list', { name: 'Export progress' });
    await waitFor(() =>
      expect(within(list).getAllByRole('button', { name: 'Show in Finder' })).toHaveLength(3),
    );
    fireEvent.click(within(list).getAllByRole('button', { name: 'Show in Finder' })[0]!);
    await waitFor(() => expect(s.revealed).toEqual(['/out/Editor - Main.mp4']));
  });

  it('helpers: check numbers and the qa.png URL', () => {
    expect(checkNumbers(FAIL_QA.checks[0] as never)).toBe(
      'integratedLufs -20.1, targetLufs -14, deltaLu -6.1',
    );
    expect(projectFileUrl('p_a', '/h/Projects/p_a/renders/qa/s/qa.png')).toBe(
      'vox-media://p/p_a/renders/qa/s/qa.png',
    );
    expect(projectFileUrl('p_a', '/elsewhere/qa.png')).toBeNull();
  });
});
