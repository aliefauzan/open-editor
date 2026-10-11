// UI gate screenshots of the phase 10b screens (PROMPT step 7): quick-clips start screen and
// progress, the editor with the next-steps bar, Subtitles panel with Pauses & fillers, media bin
// (library and archive tab), export dialog with the audio check, style gallery and detail, and the
// error states (SCHEMA_TOO_NEW message, offline block + relink). JPEGs go to VOX_EVIDENCE_DIR
// (default: a temp folder).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEngine } from '@vox/engine';
import { makeOfflineProject } from '../../../scripts/make-offline-project.ts';
import { REPO, STYLES, launchApp, tempHome } from './helpers/app.ts';

const OUT = process.env['VOX_EVIDENCE_DIR'] ?? mkdtempSync(join(tmpdir(), 'vox-ui-b-'));
const SEED = join(
  REPO,
  'packages',
  'engine',
  'test',
  'fixtures',
  'assets',
  'media',
  'talking-head-20s.mp4',
);
let app: ElectronApplication;
let page: Page;
let errors: string[];

const shot = (name: string, selector?: string) =>
  (selector ? page.locator(selector).first() : page).screenshot({
    path: join(OUT, `10b-${name}.jpg`),
    type: 'jpeg',
    quality: 70,
  });

const answer = (a: string | string[] | null) =>
  app.evaluate((_e, x) => {
    (
      globalThis as unknown as { __voxTest: { answerDialog(v: unknown): void } }
    ).__voxTest.answerDialog(x);
  }, a);

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  const t = tempHome('vox-ui-b-');
  const e = openEngine({ projectsDir: t.projectsDir, stylesDirs: [STYLES] });
  const off = await makeOfflineProject(e, 'Offline media');
  // a clip whose file is gone: the offline block
  await e.applyOp(
    off.projectId,
    {
      op: 'addMedia',
      args: {
        media: {
          id: 'm_gone',
          kind: 'video',
          path: 'media/gone.mp4',
          durationMs: 4000,
          width: 1920,
          height: 1080,
          hasAudio: false,
          origin: { type: 'upload' },
          tags: [],
        },
      },
    } as never,
    { actor: 'cli' },
  );
  await e.applyOp(
    off.projectId,
    {
      op: 'placeClip',
      args: {
        sequenceId: off.sequenceId,
        trackId: 'V2',
        mediaId: 'm_gone',
        startMs: 2000,
        durationMs: 3000,
      },
    } as never,
    { actor: 'cli' },
  );
  const newer = await e.createProject('From a newer app');
  const pj = join(t.projectsDir, newer.id, 'project.json');
  const raw = JSON.parse(readFileSync(pj, 'utf8')) as { schemaVersion: number };
  writeFileSync(pj, JSON.stringify({ ...raw, schemaVersion: raw.schemaVersion + 1 }));
  ({ app, page, consoleErrors: errors } = await launchApp(t));
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
});
afterAll(async () => {
  await app?.close();
});

describe('phase 10b screens (UI gate)', () => {
  it('start screen, SCHEMA_TOO_NEW message', async () => {
    await page.getByTestId('quick-start').waitFor();
    await page.getByLabel('Link or video file').fill('https://www.youtube.com/watch?v=abc');
    await page.getByTestId('platform-badge').waitFor();
    await shot('start');
    await page.getByRole('button', { name: 'From a newer app' }).click();
    await page.getByTestId('schema-too-new').waitFor();
    await shot('schema-too-new');
  });

  it('quick clips: progress, then the editor with the next-steps bar', async () => {
    await page.getByLabel('Link or video file').fill('');
    await page.getByLabel('Shortest clip (s)').fill('4');
    await page.getByLabel('Longest clip (s)').fill('8');
    await answer([SEED]);
    await page.getByRole('button', { name: 'Choose file…' }).first().click();
    await page.getByTestId('quick-progress').waitFor({ timeout: 60_000 });
    await shot('quick-progress', '[data-testid="quick-start"] form');
    await page.getByTestId('next-steps').waitFor({ timeout: 300_000 });
    await page.getByTestId('player').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    await shot('editor-next-steps');
    await page.getByRole('button', { name: 'Add style' }).click();
    await shot('add-style-menu', '[data-testid="next-steps"]');
    await page.getByRole('button', { name: 'Add style' }).click();
  });

  it('Subtitles panel with Pauses & fillers', async () => {
    await page.getByRole('button', { name: 'Fix subtitles' }).click();
    await page.getByTestId('subtitles-panel').waitFor();
    await page.getByTestId('pauses-fillers').locator('summary').click();
    await page.getByTestId('pauses-fillers').getByRole('button', { name: 'Find' }).click();
    await page.getByRole('list', { name: 'Found pauses and fillers' }).waitFor();
    await page.locator('[data-testid="subtitles-panel"] [data-word-key]').first().click();
    await shot('subtitles', '#media-panel');
    await shot('editor-subtitles');
  });

  it('media bin and archive tab', async () => {
    await page.getByRole('tab', { name: 'Media' }).click();
    await page.getByTestId('media-bin').waitFor();
    await shot('media-bin', '#media-panel');
    await page.getByRole('tab', { name: 'Archive' }).click();
    await shot('archive', '#media-panel');
    await page.getByRole('tab', { name: 'Library' }).click();
  });

  it('export dialog with the audio check', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Export' });
    await dlg.waitFor();
    await dlg.getByRole('button', { name: 'Check audio' }).click();
    await expect
      .poll(
        async () => (await dlg.getByRole('region', { name: 'Audio check' }).textContent()) ?? '',
        {
          timeout: 300_000,
        },
      )
      .toMatch(/loudness/);
    await page.waitForTimeout(500);
    await shot('export-dialog', '[role="dialog"][aria-label="Export"] > div');
    await dlg.getByRole('button', { name: 'Done' }).click();
  });

  it('style gallery and detail', async () => {
    await page.getByRole('tab', { name: 'Styles' }).click();
    await page.getByRole('button', { name: 'All styles…' }).click();
    const g = page.getByRole('dialog', { name: 'Style gallery' });
    await g.waitFor();
    await page.waitForTimeout(800);
    await shot('gallery', '[role="dialog"][aria-label="Style gallery"] > div');
    await g.getByRole('list', { name: 'Installed styles' }).getByRole('button').first().click();
    await g.getByTestId('style-detail').waitFor();
    await page.waitForTimeout(800);
    await shot('gallery-detail', '[role="dialog"][aria-label="Style gallery"] > div');
    await g.getByRole('button', { name: 'Close' }).click();
  });

  it('offline media: red block in the timeline, Relink… in the inspector', async () => {
    await page.getByRole('button', { name: 'All projects' }).click();
    await page.getByRole('button', { name: 'Offline media' }).click();
    await page.getByTestId('player').waitFor({ timeout: 120_000 });
    expect(await page.getByTestId('next-steps').count()).toBe(0); // the bar stayed with the quick project
    const block = page.locator('#timeline [data-item-id]', { hasText: 'Offline' }).first();
    await block.waitFor({ timeout: 30_000 });
    await block.click({ modifiers: ['Alt'] });
    await page.getByRole('button', { name: 'Relink…' }).waitFor();
    await shot('offline', '#timeline');
    await shot('offline-editor');
  });

  it('logs no console errors (besides the offline file the player asks for)', () => {
    expect(errors.filter((e) => !e.includes('DevTools') && !e.includes('/media/m_gone.'))).toEqual(
      [],
    );
  });
});
