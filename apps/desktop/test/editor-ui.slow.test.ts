// Editor UI in the built app (phase 10a, UI gate): the offline fixture project opens in the editor
// layout, the preview plays the build, clicks select clips, the inspector follows, "Add text" and a
// text edit reach the preview (patch), B splits at the playhead, and screenshots of the top bar,
// preview, timeline and inspector go to VOX_EVIDENCE_DIR (default: a temp folder).
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Frame, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEngine } from '@vox/engine';
import { makeOfflineProject } from '../../../scripts/make-offline-project.ts';
import { STYLES, launchApp, tempHome } from './helpers/app.ts';

const OUT = process.env['VOX_EVIDENCE_DIR'] ?? mkdtempSync(join(tmpdir(), 'vox-ui-'));
let app: ElectronApplication;
let page: Page;
let errors: string[];
let projectName = '';

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  const t = tempHome('vox-ui-');
  const e = openEngine({ projectsDir: t.projectsDir, stylesDirs: [STYLES] });
  const p = await makeOfflineProject(e, 'Offline UI');
  projectName = 'Offline UI';
  void p;
  ({ app, page, consoleErrors: errors } = await launchApp(t));
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
});
afterAll(async () => {
  await app?.close();
});

/** The player's iframe (opaque origin: reachable from Playwright, not from the app). */
async function playerFrame(): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    const f = page.frames().find((x) => x.url().startsWith('vox-media://'));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  throw new Error('no player frame');
}

const shot = (name: string, selector?: string) =>
  selector
    ? page
        .locator(selector)
        .first()
        .screenshot({ path: join(OUT, `${name}.png`) })
    : page.screenshot({ path: join(OUT, `${name}.png`) });

describe('editor UI (phase 10a)', () => {
  it('opens the project in the editor layout and the preview loads', async () => {
    await page.getByRole('button', { name: projectName }).click();
    await page.getByTestId('editor').waitFor();
    await page.getByTestId('player').waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () =>
        ((document.querySelector('hyperframes-player') as unknown as { duration?: number } | null)
          ?.duration ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    );
    await expect
      .poll(() => page.getByTestId('caption-chunk').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    expect(await page.locator('#timeline [data-word-key]').count()).toBeGreaterThan(0);
    for (const name of ['Steps', 'Preview', 'Timeline', 'Inspector', 'Agent']) {
      expect(await page.getByLabel(name, { exact: true }).count()).toBeGreaterThan(0);
    }
    await shot('10a-editor');
    await shot('10a-topbar', 'header');
    await shot('10a-preview', 'section[aria-label="Preview"]');
    await shot('10a-timeline', '#timeline');
    await shot('10a-inspector-captions', '#inspector');
  });

  it('a click on a clip selects the linked pair and shows its inspector', async () => {
    const clip = page.locator('#timeline [data-item-id]').first();
    await clip.click();
    await expect.poll(() => page.locator('#timeline [data-selected]').count()).toBe(2);
    await page.getByRole('heading', { name: /Video clip/i }).waitFor();
    expect(await page.locator('#in-mode').inputValue()).toBe('auto');
    await shot('10a-inspector-video', '#inspector');
  });

  it('B splits at the playhead (one op, both linked halves)', async () => {
    const before = await page.locator('#timeline [data-item-id]').count();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // move the playhead to 5 s with frame steps from a click on the ruler is fiddly; use the store
    // through a seek command: 150 right arrows = 5 s at 30 fps
    for (let i = 0; i < 150; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('b');
    await expect.poll(() => page.locator('#timeline [data-item-id]').count()).toBe(before + 2);
    // the reload after the split keeps the playhead (vox-playhead, D-29)
    await page.waitForTimeout(1500);
    expect(await page.getByTestId('time').textContent()).toBe('00:00:05:00');
  });

  it('Add text puts a text scene at the playhead; editing it patches the preview', async () => {
    await page.getByRole('button', { name: 'Add text', exact: true }).click();
    const scene = page.locator('#timeline [data-item-id]', { hasText: 'text-overlay' });
    await scene.first().waitFor();
    await scene.first().click();
    await page.getByRole('heading', { name: 'Scene' }).waitFor();
    const field = page.locator('#inspector').getByLabel(/^text/);
    await field.fill('Hello from the UI test');
    const frame = await playerFrame();
    await expect
      .poll(
        () =>
          frame.evaluate(() =>
            (document.body.textContent ?? '').includes('Hello from the UI test'),
          ),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
    expect(await page.getByTestId('count-text').textContent()).toBe('22/160');
    await shot('10a-inspector-scene', '#inspector');
    await shot('10a-editor-scene');
  });

  it('logs no console errors', () => {
    expect(errors.filter((e) => !e.includes('DevTools'))).toEqual([]);
  });
});
