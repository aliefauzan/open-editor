// @vitest-environment jsdom
// Component tests (app spec "Testing"; plan 10a steps 3–7): top bar, preview controls, timeline
// gestures and headers, style panel, inspector (JSON-Schema forms with `template` and `geo` slots,
// sound-cue mute, framing and "Pin frame here", audio denoise, caption settings) and the agent
// placeholder, on the real engine behind a fake window.vox.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { cueList } from '@vox/engine';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '../../src/renderer/editor/AgentPanel.tsx';
import { EditorProvider } from '../../src/renderer/editor/context.tsx';
import { Inspector } from '../../src/renderer/editor/Inspector.tsx';
import { PreviewPanel } from '../../src/renderer/editor/PreviewPanel.tsx';
import { StylePanel } from '../../src/renderer/editor/StylePanel.tsx';
import { createFollow, timelineHandlers } from '../../src/renderer/editor/timeline-handlers.ts';
import { Timeline } from '../../src/renderer/editor/Timeline.tsx';
import { TopBar } from '../../src/renderer/editor/TopBar.tsx';
import type { MediaClip, SceneClip } from '../../src/shared/project.ts';
import { idle, testEditor, type TestEditor } from './ctx.ts';
import { op } from './engine-fixture.ts';

afterEach(cleanup);

beforeAll(() => {
  // jsdom has no layout: the timeline library measures with ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // a stand-in for <hyperframes-player>: records runtime data and seeks
  if (!customElements.get('hyperframes-player')) {
    customElements.define(
      'hyperframes-player',
      class extends HTMLElement {
        data: [string, unknown][] = [];
        currentTime = 0;
        paused = true;
        playbackRate = 1;
        loop = false;
        rangeStart: number | null = null;
        rangeEnd: number | null = null;
        setRuntimeData(c: string, p: unknown) {
          this.data.push([c, p]);
        }
        play() {
          this.paused = false;
          this.dispatchEvent(new Event('play'));
        }
        pause() {
          this.paused = true;
          this.dispatchEvent(new Event('pause'));
        }
        seek(t: number) {
          this.currentTime = t;
        }
      },
    );
  }
});

function mount(t: TestEditor, node: React.ReactNode) {
  return render(<EditorProvider value={t.ctx}>{node}</EditorProvider>);
}

const seq = (t: TestEditor) => t.ctx.editor.getState().project!.sequences[0]!;
const history = async (t: TestEditor) => (await t.engine.history(t.project.id)).length;

describe('top bar', () => {
  it('shows the project name, the step bar and jumps to the export stage', async () => {
    const t = await testEditor();
    mount(t, <TopBar />);
    expect(screen.getByTestId('project-name').textContent).toBe('Editor');
    const steps = within(screen.getByRole('navigation', { name: 'Steps' }));
    expect(steps.getByRole('button', { current: 'step' }).textContent).toContain('Review cut');
    fireEvent.click(steps.getByRole('button', { name: /Export/ }));
    expect(steps.getByRole('button', { current: 'step' }).textContent).toContain('Export');
    expect(screen.getByRole('dialog', { name: 'Export' })).toBeTruthy();
  });

  it('undo and redo buttons undo and redo the last edit', async () => {
    const t = await testEditor();
    mount(t, <TopBar />);
    await act(async () => {
      await t.ctx.editor.getState().apply({
        op: 'updateSequence',
        args: { sequenceId: 'seq_main', name: 'Renamed' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await idle(t);
    });
    expect(seq(t).name).toBe('Main');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
      await idle(t);
    });
    expect(seq(t).name).toBe('Renamed');
  });

  it('snapshots menu saves a snapshot and restores it', async () => {
    const t = await testEditor();
    mount(t, <TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Snapshots' }));
    fireEvent.change(screen.getByLabelText('Snapshot name'), { target: { value: 'before' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('before');
    await act(async () => {
      await op(t.engine, t.project.id, 'updateSequence', {
        sequenceId: 'seq_main',
        name: 'Changed',
      });
      await idle(t);
    });
    expect(seq(t).name).toBe('Changed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      await idle(t);
    });
    expect(seq(t).name).toBe('Main');
  });
});

describe('preview controls', () => {
  it('play/pause, frame step, in/out loop, timecode, safe area, zoom', async () => {
    const t = await testEditor();
    mount(t, <PreviewPanel />);
    const player = (await screen.findByTestId('player')) as HTMLElement & {
      paused: boolean;
      loop: boolean;
      rangeStart: number | null;
      rangeEnd: number | null;
    };
    expect(player.getAttribute('src')).toBe(
      `vox-media://p/${t.project.id}/build/seq_main/index.html`,
    );
    expect(player.getAttribute('sandbox-origin')).toBe('opaque');
    fireEvent.click(screen.getByTestId('play'));
    expect(player.paused).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(player.paused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(screen.getByTestId('time').textContent).toBe('00:00:00:02');
    fireEvent.click(screen.getByRole('button', { name: 'Mark in' }));
    act(() => t.ctx.editor.getState().setPlayhead(2000));
    fireEvent.click(screen.getByRole('button', { name: 'Mark out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Loop in to out' }));
    expect(player.loop).toBe(true);
    expect(player.rangeStart).toBeCloseTo(0.067);
    expect(player.rangeEnd).toBe(2);
    expect(screen.getByTestId('time').textContent).toBe('00:00:02:00');
    expect(screen.queryByTestId('safe-area')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Safe area' }));
    expect(screen.getByTestId('safe-area')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Preview zoom'), { target: { value: '0.5' } });
    expect(t.ctx.ui.getState().previewZoom).toBe(0.5);
  });

  it('applies patches and reloads with the saved playhead (vox-playhead)', async () => {
    const t = await testEditor();
    mount(t, <PreviewPanel />);
    const player = (await screen.findByTestId('player')) as HTMLElement & {
      data: [string, unknown][];
    };
    act(() => t.ctx.editor.getState().setPlayhead(1500));
    const patch = { id: 'it_x', start: 0, duration: 2, html: '<div></div>' };
    act(() =>
      t.fake.emit('preview.updated', {
        projectId: t.project.id,
        sequenceId: 'seq_main',
        version: 9,
        kind: 'patch',
        patches: [patch],
      }),
    );
    await waitFor(() => expect(player.data).toContainEqual(['vox-patch', patch]));
    const url = `vox-media://p/${t.project.id}/build/seq_main/index.html?v=3`;
    act(() =>
      t.fake.emit('preview.updated', {
        projectId: t.project.id,
        sequenceId: 'seq_main',
        version: 10,
        kind: 'reload',
        url,
      }),
    );
    await waitFor(() => expect(player.getAttribute('src')).toBe(url));
    expect(player.data).toContainEqual(['vox-playhead', 1.5]);
    // another sequence's update is ignored
    act(() =>
      t.fake.emit('preview.updated', {
        projectId: t.project.id,
        sequenceId: 'seq_x',
        version: 11,
        kind: 'reload',
        url: 'x',
      }),
    );
    await t.fake.settle();
    expect(player.getAttribute('src')).toBe(url);
  });
});

describe('timeline', () => {
  it('a drag sends one op on drop, never one per mouse move; partners follow live', async () => {
    const t = await testEditor();
    const follow = createFollow();
    const h = timelineHandlers(t.ctx, follow, () => []);
    const clip = seq(t).videoTracks[0]!.items[1]!;
    const calls = () => t.fake.calls.filter((c) => c.method === 'ops.apply').length;
    const before = calls();
    for (let i = 0; i < 30; i++) h.onMoving(clip.id, 4 + i * 0.1);
    expect(calls()).toBe(before);
    const partner = seq(t).audioTracks[0]!.items.find((i) => i.linkId === clip.linkId)!;
    expect(follow.offsets.get(partner.id)![0]).toBe(2900);
    h.onMoveEnd(clip.id, 9.01);
    await idle(t);
    expect(calls()).toBe(before + 1);
    expect(follow.offsets.size).toBe(0);
    // snapped to the frame grid; the linked audio has the same start
    expect(seq(t).videoTracks[0]!.items[1]!.startMs).toBe(9000);
    expect(seq(t).audioTracks[0]!.items.find((i) => i.linkId === clip.linkId)!.startMs).toBe(9000);
  });

  it('a trim sends one trimItem on release, snapped to the playhead', async () => {
    const t = await testEditor();
    t.ctx.editor.getState().setPlayhead(3000);
    const h = timelineHandlers(t.ctx, createFollow(), () => []);
    const clip = seq(t).videoTracks[0]!.items[0]!;
    for (let i = 0; i < 10; i++) h.onResizing(clip.id, 0, 3.5 - i * 0.05, 'right');
    h.onResizeEnd(clip.id, 0, 3.04, 'right');
    await idle(t);
    expect(seq(t).videoTracks[0]!.items[0]!.durationMs).toBe(3000);
  });

  it('track headers toggle lock, hide, mute and sync-lock; tabs switch sequences', async () => {
    const t = await testEditor();
    mount(t, <Timeline />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lock V1' }));
    await act(() => idle(t));
    expect(seq(t).videoTracks[0]!.locked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mute A1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide V2' }));
    await act(() => idle(t));
    expect(seq(t).audioTracks[0]!.muted).toBe(true);
    expect(seq(t).videoTracks[1]!.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '+ Audio track' }));
    await act(() => idle(t));
    expect(seq(t).audioTracks.map((x) => x.id)).toEqual(['A1', 'A2', 'A3']);
    fireEvent.click(screen.getByRole('button', { name: 'New or duplicate sequence' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate this sequence' }));
    await act(() => idle(t));
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    fireEvent.click(tabs[1]!);
    expect(t.ctx.editor.getState().sequenceId).not.toBe('seq_main');
  });
});

describe('style panel', () => {
  it('lists base templates, transitions and caption presets; + adds a scene at the playhead', async () => {
    const t = await testEditor();
    mount(t, <StylePanel />);
    const templates = within(await screen.findByRole('region', { name: 'Templates' }));
    expect(templates.getByText('title')).toBeTruthy();
    expect(templates.getByText('text-overlay')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Transitions' })).getByText('crossfade'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Caption presets' })).getByText('plain'),
    ).toBeTruthy();
    const img = screen.getByTestId('style-panel').querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^vox-media:\/\/styles\/base\/previews\//);
    act(() => t.ctx.editor.getState().setPlayhead(10000));
    fireEvent.click(templates.getByRole('button', { name: 'Add title' }));
    await act(() => idle(t));
    const scenes = seq(t)
      .videoTracks.flatMap((x) => x.items)
      .filter((i) => i.type === 'scene');
    expect(scenes.map((s) => s.startMs)).toContain(10000);
  });
});

describe('inspector', () => {
  it('a JSON-Schema form edits a scene; typing is one undo entry', async () => {
    const t = await testEditor();
    const scene = seq(t).videoTracks[1]!.items[0]!;
    t.ctx.editor.getState().select(scene.id);
    mount(t, <Inspector />);
    const title = (await screen.findByLabelText(/^title/)) as HTMLInputElement;
    expect(screen.getByTestId('count-title').textContent).toBe('5/80');
    const n = await history(t);
    for (const v of ['H', 'He', 'Hey', 'Hey!']) fireEvent.change(title, { target: { value: v } });
    await act(() => idle(t));
    expect((seq(t).videoTracks[1]!.items[0] as SceneClip).variables['title']).toBe('Hey!');
    expect(await history(t)).toBe(n + 1);
    expect(screen.getByTestId('count-title').textContent).toBe('4/80');
  });

  it('template slots get nested forms (stack, depth 1)', async () => {
    const t = await testEditor({ testStyles: true });
    await op(t.engine, t.project.id, 'updateSequence', { sequenceId: 'seq_main', styleId: 'kit' });
    await op(t.engine, t.project.id, 'addScene', {
      sequenceId: 'seq_main',
      trackId: 'V2',
      startMs: 4000,
      durationMs: 3000,
      template: 'kit/stack',
      variables: {
        panels: [
          { template: 'base/title', variables: { text: 'One' } },
          { template: 'base/title', variables: { text: 'Two' } },
        ],
      },
    });
    await idle(t);
    const stack = seq(t).videoTracks[1]!.items.find(
      (i) => i.type === 'scene' && i.template === 'kit/stack',
    )!;
    t.ctx.editor.getState().select(stack.id);
    mount(t, <Inspector />);
    const panels = await screen.findAllByLabelText('Panel template');
    expect(panels).toHaveLength(2);
    expect((panels[0] as HTMLSelectElement).value).toBe('base/title');
    const titles = screen.getAllByLabelText(/^text/) as HTMLInputElement[];
    expect(titles.map((x) => x.value)).toEqual(['One', 'Two']);
    fireEvent.change(titles[1]!, { target: { value: 'Second' } });
    await act(() => idle(t));
    const v = (seq(t).videoTracks[1]!.items.find((i) => i.id === stack.id) as SceneClip).variables;
    expect(v['panels']).toEqual([
      { template: 'base/title', variables: { text: 'One' } },
      { template: 'base/title', variables: { text: 'Second' } },
    ]);
    // min 2, max 3 panels
    expect(
      (screen.getByRole('button', { name: 'Remove panels 1' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Add panel/ }));
    await act(() => idle(t));
    expect(screen.getAllByLabelText('Panel template')).toHaveLength(3);
    expect((screen.getByRole('button', { name: /Add panel/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('geo slots search places; sound cues mute with one updateScene { sfxOff } (D-14)', async () => {
    const t = await testEditor({
      testStyles: true,
      // the engine's place search is tested in the engine (jsdom's URL breaks its data lookup here)
      handlers: {
        'geo.search': async () => [
          {
            name: 'Paris',
            country: 'France',
            iso2: 'FR',
            admin1: '',
            lat: 48.87,
            lon: 2.33,
            population: 1,
            capital: true,
          },
        ],
      },
    });
    await op(t.engine, t.project.id, 'updateSequence', {
      sequenceId: 'seq_main',
      styleId: 'paper',
    });
    await op(t.engine, t.project.id, 'addScene', {
      sequenceId: 'seq_main',
      trackId: 'V2',
      startMs: 4000,
      durationMs: 3000,
      template: 'paper/map',
      variables: { places: [{ name: 'Lisbon', lat: 38.72, lon: -9.14 }] },
    });
    await idle(t);
    const map = seq(t).videoTracks[1]!.items.find(
      (i) => i.type === 'scene' && i.template === 'paper/map',
    )!;
    t.ctx.editor.getState().select(map.id);
    mount(t, <Inspector />);
    expect((await screen.findByTestId('geo-value')).textContent).toContain('Lisbon');
    fireEvent.change(screen.getByLabelText(/Search a place/), { target: { value: 'Paris' } });
    const option = await screen.findByRole('option', { name: /^Paris/ });
    fireEvent.click(option);
    await act(() => idle(t));
    const places = (seq(t).videoTracks[1]!.items.find((i) => i.id === map.id) as SceneClip)
      .variables['places'] as { name: string; lat: number }[];
    expect(places[0]!.name).toBe('Paris');
    expect(places[0]!.lat).toBeGreaterThan(48);
    // sound cues: muting one is one undoable op and it leaves the cue list
    const n = await history(t);
    fireEvent.click(screen.getByLabelText('Play cue land'));
    await act(() => idle(t));
    expect((seq(t).videoTracks[1]!.items.find((i) => i.id === map.id) as SceneClip).sfxOff).toEqual(
      ['land'],
    );
    expect(await history(t)).toBe(n + 1);
    // the cue list compile writes to cues.json (the test styles' templates do not compile)
    const lookup = { get: (id: string) => t.engine.styles.get('paper').templates[id] as never };
    const cues = cueList(seq(t) as never, lookup).cues.map((c) => c.cueName);
    expect(cues).not.toContain('land');
    expect(cues).toContain('tick');
    await act(async () => {
      await t.ctx.editor.getState().undo();
      await idle(t);
    });
    expect(
      (seq(t).videoTracks[1]!.items.find((i) => i.id === map.id) as SceneClip).sfxOff ?? [],
    ).toEqual([]);
  });

  it('framing auto: stability, track speed and Pin frame here (relative atMs, one undo entry)', async () => {
    const t = await testEditor();
    const clip = seq(t).videoTracks[0]!.items[1]! as MediaClip; // 4000–8000
    t.ctx.editor.getState().select(clip.id, { alt: true });
    mount(t, <Inspector />);
    fireEvent.change(await screen.findByLabelText('Framing'), { target: { value: 'auto' } });
    await act(() => idle(t));
    fireEvent.change(screen.getByLabelText('Stability'), { target: { value: 'locked' } });
    await act(() => idle(t));
    fireEvent.change(screen.getByLabelText('Track speed'), { target: { value: 'fast' } });
    await act(() => idle(t));
    const pin = screen.getByRole('button', { name: 'Pin frame here' }) as HTMLButtonElement;
    expect(pin.disabled).toBe(true); // playhead outside the clip
    act(() => t.ctx.editor.getState().setPlayhead(5500));
    const n = await history(t);
    fireEvent.click(pin);
    await act(() => idle(t));
    const frame = (seq(t).videoTracks[0]!.items[1] as MediaClip).frame!;
    expect(frame).toMatchObject({ mode: 'auto', stability: 'locked', trackSpeed: 'fast' });
    expect(frame.keyframes).toEqual([{ atMs: 1500, x: 0.5, y: 0.5, scale: 1 }]);
    expect(await history(t)).toBe(n + 1);
    expect(
      within(screen.getByRole('list', { name: 'Pinned frames' })).getByText(/0:01\.5/),
    ).toBeTruthy();
    // moving the clip keeps the pin on the same source frame (relative atMs)
    await act(async () => {
      await t.ctx.editor.getState().apply({
        op: 'moveItem',
        args: { sequenceId: 'seq_main', itemId: clip.id, startMs: 10000 },
      });
      await idle(t);
    });
    expect((seq(t).videoTracks[0]!.items[1] as MediaClip).frame!.keyframes![0]!.atMs).toBe(1500);
    await act(async () => {
      await t.ctx.editor.getState().undo();
      await t.ctx.editor.getState().undo();
      await idle(t);
    });
    expect((seq(t).videoTracks[0]!.items[1] as MediaClip).frame!.keyframes).toBeUndefined();
  });

  it('audio clip: denoise, volume slider is one undo entry', async () => {
    const t = await testEditor();
    const a = seq(t).audioTracks[0]!.items[0]!;
    t.ctx.editor.getState().select(a.id, { alt: true });
    mount(t, <Inspector />);
    fireEvent.change(await screen.findByLabelText('Denoise'), { target: { value: 'light' } });
    await act(() => idle(t));
    expect((seq(t).audioTracks[0]!.items[0] as MediaClip).denoise).toBe('light');
    const n = await history(t);
    const slider = screen.getByRole('slider', { name: 'Volume' });
    for (let i = 1; i <= 20; i++) fireEvent.change(slider, { target: { value: String(i / 20) } });
    await act(() => idle(t));
    expect((seq(t).audioTracks[0]!.items[0] as MediaClip).volume).toBe(1);
    expect(await history(t)).toBe(n + 1);
  });

  it('caption settings with nothing selected', async () => {
    const t = await testEditor();
    mount(t, <Inspector />);
    const add = screen.queryByRole('button', { name: 'Add captions' });
    if (add) {
      fireEvent.click(add);
      await act(() => idle(t));
    }
    const words = (await screen.findByLabelText('Words per chunk')) as HTMLInputElement;
    fireEvent.change(words, { target: { value: '4' } });
    fireEvent.blur(words);
    await act(() => idle(t));
    expect(seq(t).captions!.maxWords).toBe(4);
    fireEvent.click(screen.getByLabelText(/Auto-emphasis/));
    await act(() => idle(t));
    expect(seq(t).captions!.autoEmphasis).toBe(true);
    fireEvent.change(screen.getByRole('slider', { name: 'Vertical position' }), {
      target: { value: '60' },
    });
    await act(() => idle(t));
    expect(seq(t).captions!.position.yPct).toBe(60);
  });
});

describe('agent panel placeholder', () => {
  it('links to settings', async () => {
    const t = await testEditor();
    mount(t, <AgentPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(t.ctx.ui.getState().settingsOpen).toBe(true);
    void vi;
  });
});

describe('crop handle on the preview', () => {
  it('a manual clip pans with the keyboard; drags of one gesture are one undo entry', async () => {
    const { CropHandle } = await import('../../src/renderer/editor/CropHandle.tsx');
    const t = await testEditor();
    const clip = seq(t).videoTracks[0]!.items[0]!;
    await act(async () => {
      await t.ctx.editor.getState().apply({
        op: 'updateClip',
        args: { sequenceId: 'seq_main', itemId: clip.id, frame: { mode: 'manual' } },
      });
      await idle(t);
    });
    t.ctx.editor.getState().select(clip.id, { alt: true });
    t.ctx.editor.getState().setPlayhead(1000);
    mount(
      t,
      <div style={{ position: 'relative' }}>
        <CropHandle />
      </div>,
    );
    const handle = await screen.findByTestId('crop-handle');
    const n = await history(t);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    await act(() => idle(t));
    expect((seq(t).videoTracks[0]!.items[0] as MediaClip).frame).toMatchObject({
      mode: 'manual',
      x: 0.52,
      y: 0.51,
    });
    expect(await history(t)).toBe(n + 1);
  });
});
