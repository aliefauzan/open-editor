// Step 9 smoke test: the app starts, opens the 90 s fixture, the player's current time advances
// during play under the production CSP and the opaque sandbox, and there are no console errors.
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { launchApp, tempHome } from '../test/helpers/app.ts';
import { engineAt, SPIKE_SRC, spikeProject } from '../test/helpers/fixture.ts';

test.skip(!existsSync(SPIKE_SRC), `fixture missing: ${SPIKE_SRC} (run packages/engine/test/fixtures/make.sh)`);

test('smoke: app starts, opens the 90 s fixture, the preview plays', async () => {
  const t = tempHome('vox-smoke-');
  await spikeProject(engineAt(t.projectsDir, t.home));
  const { app, page, consoleErrors } = await launchApp(t);
  try {
    await page.getByRole('button', { name: 'Spike 90 s' }).click();
    const player = page.getByTestId('player');
    await player.waitFor({ timeout: 120_000 });
    expect(await player.getAttribute('sandbox-origin')).toBe('opaque');
    expect(await player.getAttribute('src')).toMatch(/^vox-media:\/\/p\/p_[a-z0-9]+\/build\/seq_main\/index\.html$/);
    await page.waitForFunction(
      () => (document.querySelector('hyperframes-player') as unknown as { duration?: number })?.duration! > 0,
      undefined,
      { timeout: 120_000 },
    );
    const time = () =>
      page.evaluate(() => (document.querySelector('hyperframes-player') as unknown as { currentTime: number }).currentTime);
    const t0 = await time();
    await page.getByTestId('play').click();
    await page.waitForTimeout(2500);
    const t1 = await time();
    await page.getByTestId('play').click();
    expect(t1 - t0).toBeGreaterThan(1.5);
    expect(await page.getByTestId('time').textContent()).not.toBe('0.00 s');
    expect(page.url()).toBe('vox-app://app/index.html');
    expect(consoleErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
