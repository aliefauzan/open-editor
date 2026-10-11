// Step B7, E2E manual-edit path (app spec "Testing" → E2E, without the agent part; phase 13 adds it):
// on the offline fixture project, import media → drag it to the timeline (linked pair) → trim and
// split → add a transition and text → add a scene and edit its text → the preview shows the change →
// export draft MP4 + SRT with the right duration, and OTIO, into a folder chosen in the dialog.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  SEED,
  answerDialog,
  durationMs,
  exportTo,
  openProject,
  previewHasText,
  projectState,
  seqEnd,
  start,
  tempDir,
  type Session,
} from './helpers.ts';

let s: Session;
test.afterAll(async () => {
  await s?.app.close();
});

test('manual-edit path: import, drag, trim, split, transition, text, scene, export MP4 + SRT + OTIO', async () => {
  s = await start({ offline: 'Manual E2E' });
  const { page } = s;
  const pid = s.offline!.projectId;
  await openProject(s, 'Manual E2E');

  // import media (the .mov copy) through the native dialog (answered by the test build)
  const before = await projectState(page, pid);
  const known = new Set((before.project['media'] as { id: string }[]).map((m) => m.id));
  await page.getByRole('tab', { name: 'Media' }).click();
  await answerDialog(s, [SEED('mov')]);
  await page.getByRole('button', { name: 'Import…' }).click();
  await expect(page.locator('[data-media-id]')).toHaveCount(2, { timeout: 120_000 });
  const mediaIds = await page
    .locator('[data-media-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-media-id')!));
  const newId = mediaIds.find((id) => !known.has(id))!;
  expect(newId).toBeTruthy();

  // drag it onto V1 after the existing 20 s clip: a linked V1/A1 pair
  const itemsBefore = await page.locator('#timeline [data-item-id]').count();
  const src = page.locator(`[data-media-id="${newId}"]`);
  const area = page.locator('#timeline .timeline-editor-edit-area');
  const pxPerSec = 40;
  await src.dragTo(area, { targetPosition: { x: 16 + 20.5 * pxPerSec, y: 12 } });
  await expect
    .poll(() => page.locator('#timeline [data-item-id]').count(), { timeout: 30_000 })
    .toBe(itemsBefore + 2);
  let seq = (await projectState(page, pid)).project.sequences[0]!;
  const placed = seq.videoTracks.flatMap((t) => t.items).find((i) => i.mediaId === newId)!;
  expect(placed).toBeTruthy();
  expect(seq.audioTracks.flatMap((t) => t.items).some((i) => i.mediaId === newId)).toBe(true);

  // trim: the new clip's out point to 6 s of source (inspector, one op)
  await page.locator(`#timeline [data-item-id="${placed.id}"]`).click();
  await page.locator('#in-out').first().fill('6000');
  await page.locator('#in-out').first().press('Enter');
  await expect
    .poll(async () => seqEnd((await projectState(page, pid)).project.sequences[0]!), {
      timeout: 15_000,
    })
    .toBe(placed.startMs + 6000);

  // split the first clip at 5 s (B splits the selected clip at the playhead)
  const first = seq.videoTracks
    .flatMap((t) => t.items)
    .find((i) => i.startMs === 0 && i.type === 'media')!;
  await page.locator(`#timeline [data-item-id="${first.id}"]`).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const n0 = await page.locator('#timeline [data-item-id]').count();
  for (let i = 0; i < 150; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('b');
  await expect.poll(() => page.locator('#timeline [data-item-id]').count()).toBe(n0 + 2);

  // a transition on the cut at 5 s (inspector "Transition in" of the clip that starts there)
  seq = (await projectState(page, pid)).project.sequences[0]!;
  const second = seq.videoTracks[0]!.items.find((i) => i.startMs === 5000)!;
  await page.locator(`#timeline [data-item-id="${second.id}"]`).click();
  await page.locator('#in-tx').first().selectOption('base/crossfade');
  await expect
    .poll(async () => {
      const q = (await projectState(page, pid)).project.sequences[0]!;
      return (
        q.videoTracks[0]!.items.find((i) => i.id === second.id) as unknown as {
          transitionIn?: { template: string };
        }
      ).transitionIn?.template;
    })
    .toBe('base/crossfade');

  // add text and edit it: the preview shows it
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  const textScene = page.locator('#timeline [data-item-id]', { hasText: 'text-overlay' });
  await textScene.first().click();
  await page.locator('#inspector').getByLabel(/^text/).fill('Manual text E2E');
  await previewHasText(page, 'Manual text E2E');

  // add a scene from the style panel and edit its text
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 240; i++) await page.keyboard.press('ArrowRight'); // past the text scene (13 s)
  await page.getByRole('tab', { name: 'Styles' }).click();
  await page.getByRole('button', { name: 'Add title', exact: true }).click();
  const title = page.locator('#timeline [data-item-id]', { hasText: /title/ });
  await title.first().click();
  await page
    .locator('#inspector')
    .getByLabel(/^title/)
    .fill('Scene title E2E');
  await previewHasText(page, 'Scene title E2E');

  // export draft MP4 + SRT + OTIO into a chosen folder
  const out = tempDir('vox-e2e-out-');
  const expected = seqEnd((await projectState(page, pid)).project.sequences[0]!);
  await exportTo(s, out, { formats: ['mp4', 'srt', 'otio'], quality: 'draft' });
  const files = readdirSync(out);
  const mp4 = files.find((f) => f.endsWith('.mp4'))!;
  const srt = files.find((f) => f.endsWith('.srt'))!;
  expect(files.some((f) => f.endsWith('.otio'))).toBe(true);
  expect(Math.abs(durationMs(join(out, mp4)) - expected)).toBeLessThanOrEqual(100);
  const cues = readFileSync(join(out, srt), 'utf8');
  const ends = [...cues.matchAll(/--> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)].map(
    ([, h, m, sec, ms]) => ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000 + Number(ms),
  );
  expect(ends.length).toBeGreaterThan(0);
  expect(Math.max(...ends)).toBeLessThanOrEqual(expected);
  expect(existsSync(join(out, mp4))).toBe(true);
  expect(s.errors.filter((e) => !e.includes('DevTools'))).toEqual([]);
});
