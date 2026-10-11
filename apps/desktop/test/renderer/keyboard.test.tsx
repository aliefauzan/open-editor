// @vitest-environment jsdom
// Keyboard shortcuts (app spec "Main editor" → Keyboard; one test per shortcut) and what the commands
// do to the project through the real engine.
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorProvider, type EditorContext } from '../../src/renderer/editor/context.tsx';
import { useKeyboard } from '../../src/renderer/editor/keyboard.ts';
import type { MenuCommand } from '../../src/shared/commands.ts';
import type { MediaClip } from '../../src/shared/project.ts';
import { idle, testEditor } from './ctx.ts';

afterEach(cleanup);

function Layer() {
  useKeyboard();
  return <input aria-label="field" />;
}

async function mounted() {
  const t = await testEditor();
  const run = vi.fn<(c: MenuCommand) => void>();
  const ctx: EditorContext = { ...t.ctx, run };
  const r = render(
    <EditorProvider value={ctx}>
      <Layer />
    </EditorProvider>,
  );
  return { ...t, run, r };
}

const SHORTCUTS: [string, Partial<KeyboardEventInit>, MenuCommand][] = [
  ['space', { key: ' ' }, 'playPause'],
  ['J', { key: 'j' }, 'shuttleBack'],
  ['K', { key: 'k' }, 'pause'],
  ['L', { key: 'l' }, 'shuttleForward'],
  ['I', { key: 'i' }, 'markIn'],
  ['O', { key: 'o' }, 'markOut'],
  ['B', { key: 'b' }, 'blade'],
  ['delete', { key: 'Backspace' }, 'delete'],
  ['forward delete', { key: 'Delete' }, 'delete'],
  ['shift+delete', { key: 'Backspace', shiftKey: true }, 'rippleDelete'],
  ['cmd+C', { key: 'c', metaKey: true }, 'copy'],
  ['cmd+V', { key: 'v', metaKey: true }, 'paste'],
  ['cmd+D', { key: 'd', metaKey: true }, 'duplicate'],
  ['cmd+Z', { key: 'z', metaKey: true }, 'undo'],
  ['shift+cmd+Z', { key: 'z', metaKey: true, shiftKey: true }, 'redo'],
  ['left arrow', { key: 'ArrowLeft' }, 'frameBack'],
  ['right arrow', { key: 'ArrowRight' }, 'frameForward'],
  ['+', { key: '+', shiftKey: true }, 'zoomIn'],
  ['=', { key: '=' }, 'zoomIn'],
  ['-', { key: '-' }, 'zoomOut'],
];

describe('keyboard shortcuts', () => {
  it.each(SHORTCUTS)('%s runs %s', async (_name, key, command) => {
    const { run } = await mounted();
    fireEvent.keyDown(window, key);
    expect(run).toHaveBeenCalledWith(command);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keys typed into a text field stay there', async () => {
    const { run, r } = await mounted();
    const input = r.getByLabelText('field');
    fireEvent.keyDown(input, { key: 'b' });
    fireEvent.keyDown(input, { key: ' ' });
    expect(run).not.toHaveBeenCalled();
  });

  it('a native menu command runs the same command', async () => {
    const { run, fake } = await mounted();
    fake.emit('menu.command', { command: 'blade' });
    fake.emit('menu.command', { command: 'nope' });
    await fake.settle();
    expect(run.mock.calls).toEqual([['blade']]);
  });
});

describe('commands', () => {
  const v1 = (ctx: EditorContext) =>
    ctx.editor.getState().project!.sequences[0]!.videoTracks[0]!.items as MediaClip[];
  const a1 = (ctx: EditorContext) =>
    ctx.editor.getState().project!.sequences[0]!.audioTracks[0]!.items as MediaClip[];

  it('B splits the selected clip (and its linked audio) at the playhead', async () => {
    const t = await testEditor();
    const e = t.ctx.editor.getState();
    e.select(v1(t.ctx)[0]!.id);
    e.setPlayhead(2000);
    t.ctx.run('blade');
    await idle(t);
    expect(v1(t.ctx).map((i) => [i.startMs, i.durationMs])).toEqual([
      [0, 2000],
      [2000, 2000],
      [4000, 4000],
    ]);
    expect(a1(t.ctx)).toHaveLength(3);
  });

  it('delete removes the selection; one undo restores it', async () => {
    const t = await testEditor();
    t.ctx.editor.getState().select(v1(t.ctx)[1]!.id);
    t.ctx.run('delete');
    await idle(t);
    expect(v1(t.ctx)).toHaveLength(1);
    expect(a1(t.ctx)).toHaveLength(1);
    t.ctx.run('undo');
    await idle(t);
    expect(v1(t.ctx)).toHaveLength(2);
    t.ctx.run('redo');
    await idle(t);
    expect(v1(t.ctx)).toHaveLength(1);
  });

  it('shift+delete ripple-deletes and closes the gap', async () => {
    const t = await testEditor();
    t.ctx.editor.getState().select(v1(t.ctx)[0]!.id);
    t.ctx.run('rippleDelete');
    await idle(t);
    expect(v1(t.ctx).map((i) => i.startMs)).toEqual([0]);
    expect(a1(t.ctx).map((i) => i.startMs)).toEqual([0]);
  });

  it('copy + paste at the playhead, and duplicate after the selection', async () => {
    const t = await testEditor();
    const e = t.ctx.editor.getState();
    e.select(v1(t.ctx)[1]!.id);
    t.ctx.run('copy');
    e.setPlayhead(10000);
    t.ctx.run('paste');
    await idle(t);
    expect(v1(t.ctx).map((i) => i.startMs)).toEqual([0, 4000, 10000]);
    expect(a1(t.ctx).map((i) => i.startMs)).toEqual([0, 4000, 10000]);
    t.ctx.editor.getState().select(v1(t.ctx)[2]!.id);
    t.ctx.run('duplicate');
    await idle(t);
    expect(v1(t.ctx).map((i) => i.startMs)).toEqual([0, 4000, 10000, 14000]);
  });

  it('arrow keys step one frame; I/O set the loop; +/- zoom; addText', async () => {
    const t = await testEditor();
    const seek = vi.fn();
    t.ctx.player.current = { play: vi.fn(), pause: vi.fn(), seekMs: seek, isPlaying: () => false };
    t.ctx.run('frameForward');
    t.ctx.run('frameForward');
    expect(t.ctx.editor.getState().playheadMs).toBe(67); // 2 frames at 30 fps
    t.ctx.run('frameBack');
    expect(t.ctx.editor.getState().playheadMs).toBe(33);
    expect(seek).toHaveBeenLastCalledWith(33);
    t.ctx.run('markIn');
    t.ctx.editor.getState().setPlayhead(3000);
    t.ctx.run('markOut');
    expect(t.ctx.ui.getState()).toMatchObject({ inMs: 33, outMs: 3000 });
    const z = t.ctx.ui.getState().pxPerSec;
    t.ctx.run('zoomIn');
    expect(t.ctx.ui.getState().pxPerSec).toBeGreaterThan(z);
    t.ctx.run('zoomOut');
    expect(t.ctx.ui.getState().pxPerSec).toBeCloseTo(z);
    await act(async () => {
      t.ctx.editor.getState().setPlayhead(1000);
      t.ctx.run('addText');
      await idle(t);
    });
    const tracks = t.ctx.editor.getState().project!.sequences[0]!.videoTracks;
    const texts = tracks
      .flatMap((tr) => tr.items)
      .filter((i) => i.type === 'scene' && i.template === 'base/text-overlay');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.startMs).toBe(1000);
  });

  it('space plays and pauses the player', async () => {
    const t = await testEditor();
    let playing = false;
    t.ctx.player.current = {
      play: () => void (playing = true),
      pause: () => void (playing = false),
      seekMs: vi.fn(),
      isPlaying: () => playing,
    };
    t.ctx.run('playPause');
    expect(playing).toBe(true);
    t.ctx.run('playPause');
    expect(playing).toBe(false);
  });
});
