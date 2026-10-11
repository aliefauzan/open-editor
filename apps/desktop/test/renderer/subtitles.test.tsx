// @vitest-environment jsdom
// Step A2: the Subtitles panel, one test per action (edit, multi-word edit, find and replace, nudge,
// split, merge, hide, emphasis, reset one, reset all, delete word, Pauses & fillers find / untick /
// apply and the STALE re-find; D-15 actions marked). Each action is one undo entry, and the derived
// captions (what the preview renders) show the edit.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorProvider } from '../../src/renderer/editor/context.tsx';
import { SubtitlesPanel } from '../../src/renderer/editor/SubtitlesPanel.tsx';
import { findReplaceOp, nudgeOp, toSourceMs } from '../../src/renderer/editor/subtitles.ts';
import type { CaptionChunk, Project } from '../../src/shared/project.ts';
import { idle, testEditor, type TestEditor } from './ctx.ts';
import { op } from './engine-fixture.ts';

afterEach(cleanup);

const TRANSCRIPT = join(
  import.meta.dirname, '..', '..', '..', '..', 'packages', 'engine', 'test', 'fixtures', 'transcripts', 'speech-fillers.json',
);
const key = (i: number) => `m_v:r1:${i}`;

let SEQ = 'seq_main';

/**
 * seq_main with the speech-fillers transcript on m_v (two V1/A1 cuts 0–4 s, 4–8 s) and captions on;
 * `single`: a new sequence seq_one with one uncut 0–8 s pair instead (no cut inside a pause).
 */
async function setup(o: { single?: boolean } = {}): Promise<TestEditor> {
  const t = await testEditor();
  const dir = join(t.engine.projectsDir, t.project.id);
  mkdirSync(join(dir, 'transcripts'), { recursive: true });
  copyFileSync(TRANSCRIPT, join(dir, 'transcripts', 'm_v.json'));
  await op(t.engine, t.project.id, 'updateMedia', {
    mediaId: 'm_v',
    patch: { transcriptPath: 'transcripts/m_v.json', transcriptRev: 'r1' },
  });
  SEQ = o.single ? 'seq_one' : 'seq_main';
  if (o.single) {
    await op(t.engine, t.project.id, 'addSequence', { name: 'One', id: SEQ });
    await op(t.engine, t.project.id, 'placeClip', {
      sequenceId: SEQ,
      trackId: 'V1',
      mediaId: 'm_v',
      startMs: 0,
      durationMs: 8000,
      withAudio: true,
    });
  }
  await op(t.engine, t.project.id, 'setCaptions', { sequenceId: SEQ, enabled: true });
  await t.ctx.editor.getState().reload();
  await idle(t);
  t.ctx.editor.getState().setSequence(SEQ);
  render(
    <EditorProvider value={t.ctx}>
      <SubtitlesPanel />
    </EditorProvider>,
  );
  await screen.findAllByTestId('subtitle-chunk');
  return t;
}

const chunks = (t: TestEditor) =>
  t.engine.captions(t.project.id, SEQ) as unknown as Promise<CaptionChunk[]>;
const words = async (t: TestEditor) =>
  (await chunks(t)).flatMap((c) => c.lines.flatMap((l) => l.words));
const history = async (t: TestEditor) => (await t.engine.history(t.project.id)).length;
const project = async (t: TestEditor) => (await t.engine.getProject(t.project.id)) as unknown as Project;
const seqEnd = async (t: TestEditor) => {
  const s = (await project(t)).sequences.find((q) => q.id === SEQ)!;
  return Math.max(...s.videoTracks[0]!.items.map((i) => i.startMs + i.durationMs));
};

/** Runs `act`, expects exactly one new history entry, then one undo restores `snapshot`. */
async function oneUndo<T>(t: TestEditor, snapshot: () => Promise<T>, action: () => void | Promise<void>) {
  const before = await snapshot();
  const n = await history(t);
  await act(async () => {
    await action();
  });
  await waitFor(async () => expect(await history(t)).toBe(n + 1));
  await idle(t);
  const after = await snapshot();
  expect(after).not.toEqual(before);
  await t.ctx.editor.getState().undo();
  await idle(t);
  expect(await snapshot()).toEqual(before);
  return after;
}

function word(k: string) {
  return document.querySelector(`[data-word-key="${k}"]`) as HTMLElement;
}
async function editWord(k: string, text: string) {
  fireEvent.doubleClick(word(k));
  const input = await screen.findByRole('textbox', { name: /Edit word/ });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('Subtitles panel (A2)', () => {
  it('edit a word in place', async () => {
    const t = await setup();
    const after = await oneUndo(t, () => words(t), () => editWord(key(5), 'believe'));
    expect(after.find((w) => w.key === key(5))?.text).toBe('believe');
  });

  it('multi-word edit (several words on one word key)', async () => {
    const t = await setup();
    const after = await oneUndo(t, () => words(t), () => editWord(key(0), 'So then,'));
    expect(after.filter((w) => w.key === key(0)).map((w) => w.text)).toEqual(['So', 'then,']);
  });

  it('find and replace across the sequence is one op', async () => {
    const t = await setup();
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'think' } });
    fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'feel' } });
    const after = await oneUndo(t, () => words(t), () =>
      fireEvent.click(screen.getByRole('button', { name: 'Replace all' })),
    );
    expect(after.filter((w) => w.text === 'feel').map((w) => w.key)).toEqual([key(3), key(5)]);
    expect(findReplaceOp('seq_main', [], 'x', 'y')).toBeNull();
  });

  it('nudge a word start by one frame (source-media ms)', async () => {
    const t = await setup();
    fireEvent.click(word(key(9)));
    const ovr = async () =>
      (await project(t)).sequences[0]!.captions!.overrides.find((o) => o.wordKey === key(9)) ?? null;
    const after = await oneUndo(t, ovr, () =>
      fireEvent.click(screen.getByRole('button', { name: 'Start one frame later' })),
    );
    // the derived word time sits on the frame grid (30 fps): 3083 → frame 92; one frame later → 93
    expect(after).toEqual({ wordKey: key(9), startMs: Math.round((93 * 1000) / 30) });
    const seq = (await project(t)).sequences[0]!;
    // a word in the second cut maps through its clip (startMs 4000, inMs 4000)
    expect(toSourceMs(seq, key(13), 4399)).toBe(4399);
    expect(nudgeOp(seq, { key: key(13), startMs: 4399, endMs: 4655 }, 'end', -100)).toBeNull();
  });

  it('split a chunk after a word', async () => {
    const t = await setup();
    const count = async () => (await chunks(t)).length;
    const first = (await chunks(t))[0]!.lines.flatMap((l) => l.words)[0]!;
    fireEvent.click(word(first.key));
    const after = await oneUndo(t, count, () =>
      fireEvent.click(screen.getByRole('button', { name: 'Split after' })),
    );
    expect(after).toBeGreaterThan(0);
  });

  it('merge with the next chunk (drops a break the user set)', async () => {
    const t = await setup();
    const first = (await chunks(t))[0]!.lines.flatMap((l) => l.words)[0]!;
    await op(t.engine, t.project.id, 'setCaptions', {
      sequenceId: 'seq_main',
      overrides: [{ wordKey: first.key, breakAfter: true }],
    });
    await t.ctx.editor.getState().reload();
    await idle(t);
    const count = async () => (await chunks(t)).length;
    await oneUndo(t, count, async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Merge with next' }));
    });
  });

  it('hide a word (caption only; text: null)', async () => {
    const t = await setup();
    fireEvent.click(word(key(6)));
    const after = await oneUndo(t, () => words(t), () =>
      fireEvent.click(screen.getByRole('button', { name: 'Hide' })),
    );
    expect(after.some((w) => w.key === key(6))).toBe(false);
    expect(await seqEnd(t)).toBe(8000); // hiding never cuts time
  });

  it('mark and clear emphasis', async () => {
    const t = await setup();
    fireEvent.click(word(key(10)));
    const after = await oneUndo(t, () => words(t), () =>
      fireEvent.click(screen.getByRole('button', { name: 'Emphasis' })),
    );
    expect(after.find((w) => w.key === key(10))?.emphasis).toBe(true);
  });

  it('reset one chunk to the transcript', async () => {
    const t = await setup();
    await op(t.engine, t.project.id, 'setCaptions', {
      sequenceId: 'seq_main',
      overrides: [{ wordKey: key(0), text: 'Hey,' }, { wordKey: key(12), text: 'A' }],
    });
    await t.ctx.editor.getState().reload();
    await idle(t);
    const ovr = async () => (await project(t)).sequences[0]!.captions!.overrides.map((o) => o.wordKey);
    const resets = await screen.findAllByRole('button', { name: /^Reset \d+:\d+\.\d+ to transcript$/ });
    const after = await oneUndo(t, ovr, () => fireEvent.click(resets[0]!));
    expect(after).toEqual([key(12)]);
  });

  it('reset all to the transcript', async () => {
    const t = await setup();
    await op(t.engine, t.project.id, 'setCaptions', {
      sequenceId: 'seq_main',
      overrides: [{ wordKey: key(0), text: 'Hey,' }, { wordKey: key(12), emphasis: true }],
    });
    await t.ctx.editor.getState().reload();
    await idle(t);
    const ovr = async () => (await project(t)).sequences[0]!.captions!.overrides.length;
    const after = await oneUndo(t, ovr, async () => {
      const b = screen.getByRole('button', { name: 'Reset all to transcript' });
      await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(b);
    });
    expect(after).toBe(0);
  });

  it('D-15 Delete word: selected words + Delete cut their time from video and audio (one entry)', async () => {
    const t = await setup();
    fireEvent.click(word(key(1)));
    fireEvent.click(word(key(8)), { shiftKey: true });
    const after = await oneUndo(t, () => seqEnd(t), () =>
      fireEvent.keyDown(word(key(8)), { key: 'Delete' }),
    );
    expect(after).toBeLessThan(8000);
    expect(after).toBeGreaterThan(8000 - 1000);
  });

  it('D-15 Pauses & fillers: Find lists ranges, untick one, Apply removes exactly the ticked ones', async () => {
    const t = await setup({ single: true });
    const box = screen.getByTestId('pauses-fillers');
    fireEvent.click(within(box).getByLabelText('Fillers'));
    fireEvent.click(within(box).getByLabelText('Repeats'));
    fireEvent.click(within(box).getByRole('button', { name: 'Find' }));
    const list = await within(box).findByRole('list', { name: 'Found pauses and fillers' });
    const ticks = within(list).getAllByRole('checkbox') as HTMLInputElement[];
    expect(ticks.length).toBe(2);
    expect(ticks.every((c) => c.checked)).toBe(true);
    // the dry run applied nothing
    expect(await seqEnd(t)).toBe(8000);
    const dry = (await t.engine.applyOp(
      t.project.id,
      { op: 'removePauses', args: { sequenceId: SEQ, kinds: ['pause'], dryRun: true } } as never,
      { actor: 'user' },
    )).results[0]!.report as { ranges: { startMs: number; endMs: number }[] };
    fireEvent.click(ticks[0]!);
    const kept = dry.ranges[0]!;
    const cut = dry.ranges[1]!;
    const after = await oneUndo(t, () => seqEnd(t), () =>
      fireEvent.click(within(box).getByRole('button', { name: 'Apply' })),
    );
    expect(after).toBe(8000 - (cut.endMs - cut.startMs));
    // the unticked pause is still there: a new dry run after redo finds it
    await t.ctx.editor.getState().redo();
    await idle(t);
    const again = (await t.engine.applyOp(
      t.project.id,
      { op: 'removePauses', args: { sequenceId: SEQ, kinds: ['pause'], dryRun: true } } as never,
      { actor: 'user' },
    )).results[0]!.report as { ranges: { startMs: number }[] };
    expect(again.ranges.map((r) => r.startMs)).toEqual([kept.startMs]);
  });

  it('D-15 Pauses & fillers: on STALE the list is found again and nothing is applied', async () => {
    const t = await setup();
    const box = screen.getByTestId('pauses-fillers');
    fireEvent.click(within(box).getByRole('button', { name: 'Find' }));
    await within(box).findByRole('list', { name: 'Found pauses and fillers' });
    // someone else edits meanwhile (the engine version moves past the dry run's)
    await op(t.engine, t.project.id, 'updateSequence', { sequenceId: 'seq_main', name: 'Other' });
    const n = await history(t);
    fireEvent.click(within(box).getByRole('button', { name: 'Apply' }));
    expect(await within(box).findByText(/found again/)).toBeTruthy();
    await idle(t);
    expect(await history(t)).toBe(n);
    expect(await seqEnd(t)).toBe(8000);
  });
});
