// Step 8: the engine host behind window.vox in the built app — projects, ops.apply with baseVersion
// and coalesceKey (per-op results, D-15), events forwarded, and crash → restart + reload + banner.
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, tempHome } from './helpers/app.ts';

type Hooks = { hostPid(): number | undefined; restarts(): number };
let app: ElectronApplication;
let page: Page;

beforeAll(async () => {
  ({ app, page } = await launchApp(tempHome('vox-host-')));
});
afterAll(async () => {
  await app?.close();
});

const hostPid = () =>
  app.evaluate(() => (globalThis as unknown as { __voxTest: Hooks }).__voxTest.hostPid());

describe('engine host (step 8)', () => {
  let projectId = '';

  it('creates, lists and opens projects; applies ops with baseVersion + coalesceKey; forwards events', async () => {
    const r = await page.evaluate(async () => {
      const events: unknown[] = [];
      window.vox.on('project.changed', (e) => events.push(e));
      const p = (await window.vox.projects.create('Host test')) as { id: string };
      const list = await window.vox.projects.list();
      const opened = await window.vox.projects.open(p.id);
      const apply = await window.vox.ops.apply({
        projectId: p.id,
        op: 'addSequence',
        args: { name: 'Main', id: 'seq_main' },
        baseVersion: opened.version,
        coalesceKey: 'name:seq_main',
      });
      const scene = await window.vox.ops.apply({
        projectId: p.id,
        op: 'addScene',
        args: {
          sequenceId: 'seq_main',
          trackId: 'V1',
          startMs: 0,
          durationMs: 2000,
          template: 'base/title',
          variables: { title: 'Hi' },
        },
        baseVersion: apply.version,
      });
      const stale = await window.vox.ops.apply({
        projectId: p.id,
        op: 'addSequence',
        args: { name: 'Late' },
        baseVersion: opened.version,
      });
      await new Promise((res) => setTimeout(res, 200));
      return { p, list, opened, apply, scene, stale, events };
    });
    projectId = r.p.id;
    expect(r.list.map((p) => p.id)).toContain(projectId);
    expect(r.opened.version).toBe(0);
    expect(r.apply.version).toBe(1);
    expect(r.apply.results).toEqual([
      expect.objectContaining({ op: 'addSequence', status: 'succeeded' }),
    ]);
    expect(r.scene.version).toBe(2);
    expect(r.stale.results[0]).toMatchObject({ status: 'conflicted', error: { code: 'STALE' } });
    expect(r.events).toEqual([
      expect.objectContaining({ projectId, version: 1, actor: 'user' }),
      expect.objectContaining({ projectId, version: 2 }),
    ]);
  });

  it('restarts the engine host after a crash, reloads the open project and shows a banner', async () => {
    // the picker's create form reloads the list (the API-made project shows up too)
    await page.getByLabel('New project name').fill('From the picker');
    await page.getByRole('button', { name: 'New empty project' }).click();
    await page.getByRole('button', { name: 'From the picker' }).waitFor();
    await page.getByRole('button', { name: 'Host test' }).click();
    await page.getByTestId('player').waitFor({ timeout: 60_000 });
    const pid = await hostPid();
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, 'SIGKILL');
    await page.getByTestId('banner').waitFor({ timeout: 30_000 });
    expect(await page.getByTestId('banner').textContent()).toContain('engine restarted');
    const after = await hostPid();
    expect(after).toBeGreaterThan(0);
    expect(after).not.toBe(pid);
    expect(
      await app.evaluate(() =>
        (globalThis as unknown as { __voxTest: Hooks }).__voxTest.restarts(),
      ),
    ).toBe(1);
    // the project came back from disk and the preview was rebuilt
    await page.getByTestId('player').waitFor({ timeout: 60_000 });
    const opened = await page.evaluate((id) => window.vox.projects.open(id), projectId);
    expect(opened.version).toBe(2);
  });
});
