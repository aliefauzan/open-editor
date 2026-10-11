// @vitest-environment jsdom
// Step A1: the quick-clips start screen (link check, badge, count/length, one progress view,
// LOGIN_REQUIRED → "Choose file…" and "Open Settings", the seeded make-clips path) and the next-steps bar ("Captions only"
// is one batch op), on the real engine behind a fake window.vox.
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorContext, EditorProvider } from '../../src/renderer/editor/context.tsx';
import { NextSteps } from '../../src/renderer/editor/NextSteps.tsx';
import { fewerNote, isLink, lengthRange } from '../../src/renderer/editor/quick-flow.ts';
import { QuickStart } from '../../src/renderer/editor/QuickStart.tsx';
import { AppJobs } from '../../src/engine-host/quick.ts';
import { createHandlers } from '../../src/engine-host/handlers.ts';
import type { Project } from '../../src/shared/project.ts';
import { idle, testEditor } from './ctx.ts';
import { tempEngine } from './engine-fixture.ts';
import { fakeVox } from './fake-vox.ts';

afterEach(cleanup);

const FX = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'engine',
  'test',
  'fixtures',
);
const SEED_MP4 = join(FX, 'assets', 'media', 'talking-head-20s.mp4');

function quickSetup(extra: Record<string, (...a: never[]) => unknown> = {}) {
  const engine = tempEngine();
  const box: { emit?: (n: never, p: unknown) => void } = {};
  const appJobs = new AppJobs(engine, (n, p) => box.emit?.(n as never, p), { dir: FX });
  const host = createHandlers(engine, undefined, { appJobs });
  const fake = fakeVox(engine, {
    'jobs.start': host['jobs.start']!,
    'jobs.get': host['jobs.get']!,
    // "Choose file…": main's dialog answered with the seed media
    'media.importFiles': (id: never) => host['media.importFiles']!(id, { paths: [SEED_MP4] }),
    ...extra,
  });
  box.emit = fake.emit as never;
  const ctx = createEditorContext(fake.vox);
  const onDone = vi.fn();
  render(
    <EditorProvider value={ctx}>
      <QuickStart projects={[]} onOpen={() => {}} onCreate={() => {}} onDone={onDone} />
    </EditorProvider>,
  );
  return { engine, fake, ctx, onDone };
}

describe('quick clips start screen (A1)', () => {
  it('refuses text that is not a link before any job starts', async () => {
    const { fake } = quickSetup();
    fireEvent.change(screen.getByLabelText('Link or video file'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make clips' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That is not a link');
    expect(fake.calls.map((c) => c.method)).not.toContain('projects.create');
  });

  it('shows the platform badge from media.classifyUrl', async () => {
    quickSetup();
    fireEvent.change(screen.getByLabelText('Link or video file'), {
      target: { value: 'https://www.tiktok.com/@a/video/1' },
    });
    expect((await screen.findByTestId('platform-badge')).textContent).toBe('TikTok');
    fireEvent.change(screen.getByLabelText('Link or video file'), {
      target: { value: 'https://youtu.be/abc' },
    });
    await waitFor(() => expect(screen.getByTestId('platform-badge').textContent).toBe('YouTube'));
  });

  it('validates count and length; defaults are 3 and 30–60 s', () => {
    quickSetup();
    expect((screen.getByLabelText('How many clips') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Shortest clip (s)') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('Longest clip (s)') as HTMLInputElement).value).toBe('60');
    fireEvent.change(screen.getByLabelText('Shortest clip (s)'), { target: { value: '90' } });
    expect((screen.getByRole('button', { name: 'Make clips' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(lengthRange(4, 8)).toEqual({ minMs: 4000, maxMs: 8000 });
    expect(lengthRange(9, 8)).toBeNull();
    expect(isLink('ftp://x')).toBe(false);
  });

  it('LOGIN_REQUIRED shows its hint and "Choose file…", which reuses the same project', async () => {
    const { fake, onDone, ctx } = quickSetup({
      'media.importUrl': () => {
        throw {
          code: 'LOGIN_REQUIRED',
          message: 'This post needs a login',
          hint: 'Drop the file instead',
        };
      },
    });
    fireEvent.change(screen.getByLabelText('Link or video file'), {
      target: { value: 'https://www.instagram.com/reel/x/' },
    });
    fireEvent.change(screen.getByLabelText('Shortest clip (s)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Longest clip (s)'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make clips' }));
    const alert = await screen.findByTestId('quick-error');
    expect(alert.textContent).toContain('Drop the file instead');
    // "Open Settings" opens the Settings dialog at the browser-cookies toggle (phase 13)
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(ctx.ui.getState()).toMatchObject({ settingsOpen: true, settingsFocus: 'cookies' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Choose file…' }).at(-1)!);
    await waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: 60_000 });
    expect(fake.calls.filter((c) => c.method === 'projects.create')).toHaveLength(1);
    expect(onDone.mock.calls[0]![0].sequenceIds).toHaveLength(3);
  }, 90_000);

  it('"Choose file…" runs import → make clips with one progress view and 3 clips', async () => {
    const { onDone, fake } = quickSetup();
    fireEvent.change(screen.getByLabelText('Shortest clip (s)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Longest clip (s)'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
    expect(await screen.findByRole('progressbar')).toBeTruthy();
    await waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: 60_000 });
    const o = onDone.mock.calls[0]![0] as { sequenceIds: string[]; requested: number };
    expect(o.sequenceIds).toHaveLength(3);
    expect(fewerNote(o)).toBeNull();
    const start = fake.calls.find((c) => c.method === 'jobs.start')!;
    expect(start.args).toEqual([
      'makeClips',
      expect.objectContaining({ count: 3, minMs: 4000, maxMs: 8000 }),
    ]);
  }, 90_000);

  it('fewer clips than asked → a note naming how many fit', () => {
    expect(fewerNote({ sequenceIds: ['a', 'b'], requested: 3 })).toMatch(/^Only 2 of 3 clips fit/);
  });
});

describe('next-steps bar (A1)', () => {
  it('"Captions only" is one batch: style + no overlays + the style default preset; Add style beats disabled', async () => {
    const t = await testEditor();
    t.ctx.ui.getState().set({ nextSteps: true });
    render(
      <EditorProvider value={t.ctx}>
        <NextSteps />
      </EditorProvider>,
    );
    const before = (await t.engine.history(t.project.id)).length;
    fireEvent.click(screen.getByRole('button', { name: 'Add style' }));
    const btn = await screen.findByRole('menuitem', { name: 'Captions only: Base' });
    // no editor model: "Add style beats" (labelled per style since phase 13) is disabled
    expect(
      (screen.getByRole('menuitem', { name: 'Add style beats: Base' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(btn);
    await waitFor(async () =>
      expect((await t.engine.history(t.project.id)).length).toBe(before + 1),
    );
    await idle(t);
    const p = (await t.engine.getProject(t.project.id)) as unknown as Project;
    const s = p.sequences.find((q) => q.id === 'seq_main')!;
    expect(s.styleId).toBe('base');
    expect(s.overlays).toEqual([]);
    expect(s.captions?.preset).toBe('base/plain');
    fireEvent.click(screen.getByRole('button', { name: 'Fix subtitles' }));
    expect(t.ctx.ui.getState().leftTab).toBe('subtitles');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(t.ctx.ui.getState().exportOpen).toBe(true);
  });
});
