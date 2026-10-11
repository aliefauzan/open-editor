// @vitest-environment jsdom
// Step A3: the media bin (list, search incl. transcript text, kind/origin filters, grid/list, import by
// dialog and link, drag payload, offline + relink), the archive tab (search results with licence and
// warnings, fetch, session cache) and "Replace in timeline with…".
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorProvider } from '../../src/renderer/editor/context.tsx';
import { MediaBin } from '../../src/renderer/editor/MediaBin.tsx';
import { DRAG_MEDIA } from '../../src/renderer/editor/Timeline.tsx';
import type { MediaClip, Project } from '../../src/shared/project.ts';
import { idle, testEditor, type TestEditor } from './ctx.ts';
import { op } from './engine-fixture.ts';
import type { fakeVox } from './fake-vox.ts';

afterEach(cleanup);

const SEED_MP4 = join(
  import.meta.dirname, '..', '..', '..', '..', 'packages', 'engine', 'test', 'fixtures', 'assets', 'media', 'talking-head-20s.mp4',
);
const BASE = { durationMs: 5000, width: 16, height: 9, origin: { type: 'upload' } };

async function setup(handlers: Parameters<typeof fakeVox>[1] = {}): Promise<TestEditor> {
  const t = await testEditor({ handlers });
  await op(t.engine, t.project.id, 'addMedia', {
    media: { ...BASE, id: 'm_img', kind: 'image', path: 'media/sunset.png', tags: ['warm'], origin: { type: 'archive', url: 'https://commons.wikimedia.org/x/Sunset.png' } },
  });
  await op(t.engine, t.project.id, 'addMedia', {
    media: { ...BASE, id: 'm_w', kind: 'video', path: 'media/w.mp4', hasAudio: true, tags: [], description: 'Interview take two' },
  });
  await t.ctx.editor.getState().open(t.project.id);
  await idle(t);
  render(
    <EditorProvider value={t.ctx}>
      <MediaBin />
    </EditorProvider>,
  );
  return t;
}

const items = () =>
  [...document.querySelectorAll('[data-media-id]')].map((e) => e.getAttribute('data-media-id'));

describe('media bin (A3)', () => {
  it('lists media with names, durations and tags; filters by kind and origin; grid/list', async () => {
    const t = await setup();
    expect(items()).toEqual(['m_img', 'm_v', 'm_w']); // the engine keeps media sorted by id
    expect(screen.getByTitle('Sunset.png').textContent).toContain('warm');
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'video' } });
    expect(items()).toEqual(['m_v', 'm_w']);
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Origin'), { target: { value: 'archive' } });
    expect(items()).toEqual(['m_img']);
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByRole('button', { name: 'Grid view' })).toBeTruthy();
    expect(t.ctx.editor.getState().offline).toEqual(['m_img', 'm_w']);
  });

  it('search goes through media.search (names, tags, descriptions, transcript text)', async () => {
    const t = await setup();
    fireEvent.change(screen.getByLabelText('Search media'), { target: { value: 'interview' } });
    await waitFor(() => expect(items()).toEqual(['m_w']));
    expect(t.fake.calls.some((c) => c.method === 'media.search')).toBe(true);
  });

  it('import by dialog follows the ingest job and shows the new media; import link calls importUrl', async () => {
    const urls: string[] = [];
    const box: { t?: TestEditor } = {};
    const t = await setup({
      'media.importFiles': ((id: string) => ({
        jobId: box.t!.engine.jobs.start('ingest', { projectId: id, inputs: [SEED_MP4] }),
      })) as never,
      'media.importUrl': ((_id: string, url: string) => {
        urls.push(url);
        return null;
      }) as never,
    });
    box.t = t;
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await waitFor(() => expect(items()).toHaveLength(4), { timeout: 60_000 });
    fireEvent.change(screen.getByLabelText('Import link'), { target: { value: 'https://youtu.be/x' } });
    fireEvent.keyDown(screen.getByLabelText('Import link'), { key: 'Enter' });
    await waitFor(() => expect(urls).toEqual(['https://youtu.be/x']));
  }, 90_000);

  it('dragging an item carries the timeline drop payload', async () => {
    await setup();
    const data: Record<string, string> = {};
    const li = document.querySelector('[data-media-id="m_v"]')!;
    fireEvent.dragStart(li, {
      dataTransfer: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: '' },
    });
    expect(JSON.parse(data[DRAG_MEDIA]!)).toEqual({ kind: 'media', id: 'm_v', hasAudio: true });
  });

  it('"Replace in timeline with…" is one replaceMedia op', async () => {
    const t = await setup();
    const n = (await t.engine.history(t.project.id)).length;
    fireEvent.contextMenu(document.querySelector('[data-media-id="m_v"]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace in timeline with…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Interview take two' }));
    await waitFor(async () => expect((await t.engine.history(t.project.id)).length).toBe(n + 1));
    await idle(t);
    const p = (await t.engine.getProject(t.project.id)) as unknown as Project;
    const clips = p.sequences[0]!.videoTracks[0]!.items as MediaClip[];
    expect(clips.every((c) => c.mediaId === 'm_w')).toBe(true);
  });

  it('offline media show a red block and offer Relink…', async () => {
    await setup();
    const li = document.querySelector('[data-media-id="m_w"]')!;
    expect(li.textContent).toContain('offline');
    fireEvent.contextMenu(li);
    expect(screen.getByRole('menuitem', { name: 'Relink…' })).toBeTruthy();
  });
});

describe('archive tab (A3)', () => {
  it('shows licence and warnings, fetches a result, and caches the query for the session', async () => {
    const started: { kind: string; args: Record<string, unknown> }[] = [];
    const t = await setup({
      'jobs.start': ((kind: string, args: Record<string, unknown>) => {
        started.push({ kind, args });
        return `job_${started.length}`;
      }) as never,
      'jobs.get': ((id: string) => ({
        id,
        status: 'done',
        progress: 1,
        result:
          id === 'job_1'
            ? {
                query: 'owl',
                candidates: [
                  { id: 'commons-1', title: 'Owl.jpg', license: 'CC-BY', licenseVersion: '4.0', author: 'A. Person', attribution: 'x', warning: 'Check the subject', pageUrl: 'https://commons.wikimedia.org/x' },
                ],
              }
            : { mediaId: 'm_new' },
      })) as never,
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Archive' }));
    const tab = screen.getByTestId('archive-tab');
    fireEvent.change(within(tab).getByLabelText('Search archive images'), { target: { value: 'owl' } });
    fireEvent.click(within(tab).getByRole('button', { name: 'Search' }));
    const results = await within(tab).findByRole('list', { name: 'Archive results' });
    await waitFor(() => expect(results.textContent).toContain('CC-BY 4.0 · A. Person'));
    expect(results.textContent).toContain('Check the subject');
    fireEvent.click(within(results).getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(started.map((s) => s.kind)).toEqual(['assets.search', 'assets.fetch']));
    expect(started[1]!.args).toEqual({ projectId: t.project.id, candidateId: 'commons-1' });
    // the same query again comes from the session cache (no new job)
    fireEvent.click(within(tab).getByRole('button', { name: 'Search' }));
    await idle(t);
    expect(started).toHaveLength(2);
  });
});
