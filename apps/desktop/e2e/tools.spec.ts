// Step B9, E2E editing tools on the offline fixture project (app spec "Testing" → E2E editing tools;
// D-15; app done-when 7): Pauses & fillers (find, untick one, apply = exactly the ticked ranges, one
// history entry, one cmd+Z), a coalesced slider (20 volume values within 1 s = one entry), "Pin frame
// here" + crop drag on an `auto` clip (relative keyframe, checked in a real render, follows the clip,
// one cmd+Z), and an export at each loudness target passing the audio check's loudness test.
import { expect, test } from '@playwright/test';
import {
  exportTo,
  frameAt,
  frameDiff,
  openProject,
  projectState,
  seqEnd,
  start,
  tempDir,
  vox,
  type Session,
} from './helpers.ts';

let s: Session;
let pid = '';
test.beforeAll(async () => {
  s = await start({ offline: 'Tools E2E' });
  pid = s.offline!.projectId;
  await openProject(s, 'Tools E2E');
});
test.afterAll(async () => {
  await s?.app.close();
});

/** Undo entries: a coalesced op is stored as a new entry that `replaces` the one before (D-15). */
const history = async () => {
  const list = await vox<{ version: number; replaces?: number }[]>(s.page, 'history.list', pid);
  const replaced = new Set(list.map((e) => e.replaces).filter((v) => v !== undefined));
  return list.filter((e) => !replaced.has(e.version)).length;
};
const seq = async () => (await projectState(s.page, pid)).project.sequences[0]!;
const undo = async () => {
  await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await s.page.keyboard.press('Meta+z');
};
type Range = { startMs: number; endMs: number; kind: string; wordKeys: string[] };

async function waitIdle(n: number) {
  await expect.poll(history, { timeout: 30_000 }).toBe(n);
  await s.page.waitForTimeout(1200); // past the 1 s coalescing window
}

test('Pauses & fillers: find, untick one, apply the rest as one entry; one cmd+Z restores it', async () => {
  const { page } = s;
  await page.getByRole('tab', { name: 'Subtitles' }).click();
  const box = page.getByTestId('pauses-fillers');
  await box.locator('summary').click();
  const st = await projectState(page, pid);
  const dry = await vox<{ results: { report: { ranges: Range[] } }[] }>(page, 'ops.apply', {
    projectId: pid,
    op: 'removePauses',
    args: {
      sequenceId: 'seq_main',
      minPauseMs: 350,
      kinds: ['pause', 'filler', 'repeat'],
      dryRun: true,
    },
    baseVersion: st.version,
  });
  const ranges = dry.results[0]!.report.ranges;
  expect(ranges.filter((r) => r.kind === 'pause').length).toBeGreaterThanOrEqual(2);
  const wordsBefore = (
    await vox<{ lines: { words: { key: string }[] }[] }[]>(page, 'captions.get', pid, 'seq_main')
  ).flatMap((c) => c.lines.flatMap((l) => l.words.map((w) => w.key)));
  const h0 = await history();
  await box.getByRole('button', { name: 'Find' }).click();
  const list = box.getByRole('list', { name: 'Found pauses and fillers' });
  await expect(list.getByRole('checkbox')).toHaveCount(ranges.length);
  await list.getByRole('checkbox').first().uncheck();
  await box.getByRole('button', { name: 'Apply' }).click();
  const cut = ranges.slice(1).reduce((n, r) => n + (r.endMs - r.startMs), 0);
  // exactly the ticked ranges (1 ms of frame rounding per cut at most)
  await expect
    .poll(async () => Math.abs(seqEnd(await seq()) - (20_000 - cut)), { timeout: 30_000 })
    .toBeLessThanOrEqual(ranges.length - 1);
  expect(await history()).toBe(h0 + 1);
  // the unticked range is still there; captions stay on their words
  const st2 = await projectState(page, pid);
  const again = await vox<{ results: { report: { ranges: Range[] } }[] }>(page, 'ops.apply', {
    projectId: pid,
    op: 'removePauses',
    args: {
      sequenceId: 'seq_main',
      minPauseMs: 350,
      kinds: ['pause', 'filler', 'repeat'],
      dryRun: true,
    },
    baseVersion: st2.version,
  });
  expect(again.results[0]!.report.ranges.map((r) => r.startMs)).toContain(ranges[0]!.startMs);
  const wordsAfter = (
    await vox<{ lines: { words: { key: string }[] }[] }[]>(page, 'captions.get', pid, 'seq_main')
  ).flatMap((c) => c.lines.flatMap((l) => l.words.map((w) => w.key)));
  expect(wordsAfter).toEqual(wordsBefore);
  await undo();
  await expect.poll(async () => seqEnd(await seq()), { timeout: 30_000 }).toBe(20_000);
});

test('coalesced slider: 20 volume values within 1 s are one history entry; one cmd+Z restores it', async () => {
  const { page } = s;
  await waitIdle(await history());
  const audio = (await seq()).audioTracks[0]!.items[0]!;
  await page.locator(`#timeline [data-item-id="${audio.id}"]`).click({ modifiers: ['Alt'] });
  await page.locator('#in-vol').waitFor();
  const h0 = await history();
  await page.evaluate(async () => {
    const el = document.querySelector('#in-vol') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (let i = 1; i <= 20; i++) {
      set.call(el, String(1 - i * 0.02));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await expect
    .poll(async () => (await seq()).audioTracks[0]!.items[0]!.volume, { timeout: 15_000 })
    .toBeCloseTo(0.6, 5);
  await waitIdle(h0 + 1);
  await undo();
  await expect
    .poll(async () => (await seq()).audioTracks[0]!.items[0]!.volume ?? 1, { timeout: 15_000 })
    .toBe(1);
});

async function renderFrame(atMs: number): Promise<Buffer> {
  const id = await vox<string>(s.page, 'jobs.start', 'frames', {
    projectId: pid,
    sequenceId: 'seq_main',
    atMs: [atMs],
  });
  let info: { status: string; result?: { paths: string[] }; error?: unknown } = {
    status: 'queued',
  };
  for (let i = 0; i < 600 && (info.status === 'queued' || info.status === 'running'); i++) {
    await s.page.waitForTimeout(500);
    info = await vox(s.page, 'jobs.get', id);
  }
  expect(info.status, JSON.stringify(info.error)).toBe('done');
  return frameAt(info.result!.paths[0]!, 0);
}

test('Pin frame here + crop drag: relative keyframe, pinned crop in the render, follows the clip, one cmd+Z', async () => {
  const { page } = s;
  await waitIdle(await history());
  const clip = (await seq()).videoTracks[0]!.items[0]!;
  expect(clip.frame?.mode).toBe('auto');
  const plain = await renderFrame(3000);
  await page.locator(`#timeline [data-item-id="${clip.id}"]`).click({ modifiers: ['Alt'] });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 90; i++) await page.keyboard.press('ArrowRight'); // 3 s at 30 fps
  const h0 = await history();
  await page.getByRole('button', { name: 'Pin frame here' }).click();
  const handle = page
    .getByRole('button', { name: /^(Pinned crop|Crop)$/ })
    .or(page.getByLabel(/^(Pinned crop|Crop)$/))
    .first();
  await handle.focus();
  for (let i = 0; i < 8; i++) await handle.press('ArrowRight');
  await waitIdle(h0 + 1); // pin + drag: one entry (same coalesceKey within 1 s)
  const pinned = (await seq()).videoTracks[0]!.items[0]!;
  expect(pinned.frame?.keyframes?.map((k) => k.atMs)).toEqual([3000]);
  const pinFrame = await renderFrame(3000);
  expect(frameDiff(plain, pinFrame)).toBeGreaterThan(1);
  // move the clip (linked pair) by 1 s: the keyframe is relative, so the same source frame keeps it
  const st = await projectState(page, pid);
  await vox(page, 'ops.apply', {
    projectId: pid,
    op: 'moveItem',
    args: { sequenceId: 'seq_main', itemId: clip.id, startMs: 1000 },
    baseVersion: st.version,
  });
  const moved = await renderFrame(4000);
  expect(frameDiff(pinFrame, moved)).toBeLessThan(frameDiff(plain, pinFrame));
  await undo(); // the move
  await expect.poll(async () => (await seq()).videoTracks[0]!.items[0]!.startMs).toBe(0);
  await undo(); // pin + drag
  await expect
    .poll(async () => (await seq()).videoTracks[0]!.items[0]!.frame?.keyframes ?? [])
    .toEqual([]);
});

test('an export at each loudness target passes the audio check loudness test', async () => {
  for (const [target, lufs] of [
    ['youtube', -14],
    ['tiktok', -12],
    ['broadcast', -23],
  ] as const) {
    const out = tempDir(`vox-e2e-${target}-`);
    const { audioCheck } = await exportTo(s, out, {
      formats: ['mp4'],
      quality: 'draft',
      loudness: target,
    });
    expect(audioCheck, target).toMatch(/PASSloudness/);
    expect(audioCheck).toContain(`targetLufs ${lufs}`);
  }
  expect(s.errors.filter((e) => !e.includes('DevTools'))).toEqual([]);
});
