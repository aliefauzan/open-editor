// Phase 15 step 5, E2E with the test build's style extraction (`VOX_E2E_AGENT=mock`: fixture
// measurements and a mock vision model, see src/engine-host/e2e-style.ts): the agent panel's
// "Extract style" opens the gallery on "New style from reference video"; a link makes a draft whose
// static report shows in a sandboxed frame over vox-media; Accept opens its detail view and "Set as
// style for this sequence" sets the sequence's style. A file picked in the native dialog makes another
// draft, and Discard removes it.
import { expect, test } from '@playwright/test';
import {
  answerDialog,
  openProject,
  projectState,
  SEED,
  start,
  vox,
  type Session,
} from './helpers.ts';

let s: Session;
let pid = '';
test.beforeAll(async () => {
  s = await start({ offline: 'Style E2E', env: { VOX_E2E_AGENT: 'mock' } });
  pid = s.offline!.projectId;
  await openProject(s, 'Style E2E');
});
test.afterAll(async () => {
  await s?.app.close();
});

const panel = () => s.page.getByRole('region', { name: 'New style from reference video' });

test('extract from a link, read the report, accept, set as the sequence style', async () => {
  const { page } = s;
  await page.getByRole('button', { name: 'Extract style' }).click();
  await panel().getByLabel('Style name').fill('Flat Blocks');
  await panel().getByLabel('Reference video link').fill('https://example.com/reference.mp4');
  await panel().getByRole('button', { name: 'Extract from link' }).click();
  const result = page.getByTestId('extract-result');
  await result.waitFor({ timeout: 120_000 });
  const frame = result.getByTitle('Style report');
  await expect(frame).toHaveAttribute('src', 'vox-media://styles/flat-blocks/report.html');
  await expect(frame).toHaveAttribute('sandbox', '');
  const report = frame.contentFrame();
  await expect(report.locator('#limits')).toContainText('copies no');
  await expect(report.locator('img').first()).toBeVisible();
  await result.getByRole('button', { name: 'Accept style' }).click();
  const detail = page.getByTestId('style-detail');
  await expect(detail.getByRole('heading', { name: 'Flat Blocks' })).toBeVisible();
  await detail.getByRole('button', { name: 'Set as style for this sequence' }).click();
  await expect(detail.getByRole('button', { name: 'Style of this sequence' })).toBeVisible();
  const state = await projectState(page, pid);
  expect((state.project.sequences[0] as { styleId?: string }).styleId).toBe('flat-blocks');
  expect(s.errors).toEqual([]);
});

test('a file from the native dialog makes a draft; Discard removes it', async () => {
  const { page } = s;
  await page.getByRole('button', { name: '‹ All styles' }).click();
  await page.getByRole('button', { name: 'New style from reference video' }).click();
  await panel().getByLabel('Style name').fill('Throwaway');
  await answerDialog(s, [SEED('mp4')]);
  await panel().getByRole('button', { name: 'Choose video file…' }).click();
  const result = page.getByTestId('extract-result');
  await result.waitFor({ timeout: 120_000 });
  await result.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('list', { name: 'Installed styles' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Installed styles' }).getByText('Throwaway'),
  ).toHaveCount(0);
  const list = await vox<{ id: string }[]>(page, 'styles.list');
  expect(list.map((x) => x.id)).not.toContain('throwaway');
});
