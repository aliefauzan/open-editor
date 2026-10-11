// Step B8, E2E quick path with no model configured (app spec "Testing" → E2E quick clips; D-11, D-13,
// D-16): the checked-in seed media via "Choose file…", Length 4–8 s → "Make clips" → 3 captioned
// sequence tabs → fix a word and nudge its timing in the Subtitles panel → export MP4 (burned in) + SRT
// into a folder chosen in the dialog; the SRT has the fixed word and a frame of the MP4 at that time
// differs from the same frame exported before the fix. The `.mov` and `.webm` copies make clips too.
// The test build seeds transcript, shots and facetrack by media hash; `VOX_LOCAL=1` adds the
// unseeded run (tagged `local`: mlx-whisper and the Python facetrack on the M5 only).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  SEED,
  answerDialog,
  exportTo,
  frameAt,
  changedPixels,
  start,
  tempDir,
  type Session,
} from './helpers.ts';

const sessions: Session[] = [];
test.afterAll(async () => {
  for (const s of sessions) await s.app.close().catch(() => undefined);
});

async function makeClips(s: Session, file: string): Promise<void> {
  const { page } = s;
  await page.getByLabel('Shortest clip (s)').fill('4');
  await page.getByLabel('Longest clip (s)').fill('8');
  await answerDialog(s, [file]);
  await page.getByRole('button', { name: 'Choose file…' }).first().click();
  await page
    .getByTestId('quick-progress')
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await page.getByTestId('editor').waitFor({ timeout: 900_000 });
  await page.getByTestId('next-steps').waitFor();
}

const seqTabs = (page: Page) => page.getByRole('tablist', { name: 'Sequences' }).getByRole('tab');

/** `m:ss.cc` → ms. */
const clockMs = (t: string) => {
  const [m, sec] = t.split(':') as [string, string];
  return Math.round((Number(m) * 60 + Number(sec)) * 1000);
};

async function quickPath(s: Session): Promise<void> {
  const { page } = s;
  await makeClips(s, SEED('mp4'));
  await expect(seqTabs(page)).toHaveCount(3);
  await expect
    .poll(() => page.getByTestId('caption-chunk').count(), { timeout: 60_000 })
    .toBeGreaterThan(0);

  // the plain clip before the fix
  const before = tempDir('vox-e2e-before-');
  await exportTo(s, before, { formats: ['mp4'], quality: 'draft' });
  const mp4Before = join(
    before,
    readdirSync(before).find((f) => f.endsWith('.mp4'))!,
  );

  // Fix subtitles: edit the first word of the second chunk, then nudge its end one frame later
  await page.getByRole('button', { name: 'Fix subtitles' }).click();
  const chunk = page.getByTestId('subtitle-chunk').nth(1);
  const seek = chunk.getByRole('button', { name: /^Seek to / });
  const at = clockMs(((await seek.getAttribute('aria-label')) ?? '').replace('Seek to ', ''));
  const word = chunk.locator('[data-word-key]').first();
  await word.dblclick();
  const input = page.getByRole('textbox', { name: /^Edit word/ });
  await input.fill('ZEBRA');
  await input.press('Enter');
  await expect(chunk.locator('[data-word-key]').first()).toHaveText('ZEBRA', { timeout: 15_000 });
  await chunk.locator('[data-word-key]').first().click();
  await page.getByRole('button', { name: 'End one frame later' }).click();

  // export MP4 (burned in) + SRT into a chosen folder
  const after = tempDir('vox-e2e-after-');
  await exportTo(s, after, { formats: ['mp4', 'srt'], quality: 'draft' });
  const files = readdirSync(after);
  const srt = readFileSync(
    join(
      after,
      files.find((f) => f.endsWith('.srt'))!,
    ),
    'utf8',
  );
  expect(srt).toContain('ZEBRA');
  const mp4After = join(
    after,
    files.find((f) => f.endsWith('.mp4'))!,
  );
  const t = at + 150;
  // the burned-in caption changed: a block of pixels differs (encoder noise stays under the threshold)
  expect(changedPixels(frameAt(mp4Before, t), frameAt(mp4After, t))).toBeGreaterThan(20);
}

test('quick path (seeded): 3 captioned clips, fix + nudge a word, MP4 + SRT export with the fix', async () => {
  const s = await start();
  sessions.push(s);
  await quickPath(s);
  // .mov and .webm copies via "Choose file…" each make clips
  for (const ext of ['mov', 'webm'] as const) {
    await s.page.getByRole('button', { name: 'All projects' }).click();
    await s.page.getByTestId('quick-start').waitFor();
    await makeClips(s, SEED(ext));
    expect(await seqTabs(s.page).count()).toBeGreaterThan(0);
  }
  expect(s.errors.filter((e) => !e.includes('DevTools'))).toEqual([]);
});

test('quick path unseeded @local', async () => {
  test.skip(
    process.env['VOX_LOCAL'] !== '1',
    'local only (VOX_LOCAL=1): mlx-whisper + facetrack on the M5',
  );
  const s = await start({ env: { VOX_E2E_NO_SEED: '1' } });
  sessions.push(s);
  await makeClips(s, SEED('mp4'));
  await expect(seqTabs(s.page)).toHaveCount(3);
  await expect
    .poll(() => s.page.getByTestId('caption-chunk').count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
});
