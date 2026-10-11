// @vitest-environment jsdom
// Phase 14d: the Settings toggle for local image generation. It shows the download size and the
// licence before anything is fetched, starts the `imagegen.install` job only after the user confirms,
// follows its progress, and switches off with a confirmation (`imagegen.remove`). The host side lists
// the models from the engine (installed state, size on disk) in `settings.get`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { configDeps } from '../../../../packages/agent/test/helpers/fakes.ts';
import { imagegenStatus } from '@vox/engine';
import { SettingsHost } from '../../src/engine-host/settings.ts';
import { EditorProvider } from '../../src/renderer/editor/context.tsx';
import { SettingsDialog } from '../../src/renderer/Settings.tsx';
import type { ImageGenData, SettingsData } from '../../src/shared/api.ts';
import { testEditor } from '../renderer/ctx.ts';
import { tmp } from '../setup/helpers.ts';

afterEach(cleanup);

const model = (
  over: Partial<ImageGenData['models'][number]> = {},
): ImageGenData['models'][number] => ({
  id: 'z-image-turbo',
  label: 'Z-Image-Turbo',
  license: 'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
  gated: false,
  installed: false,
  downloadBytes: 32_800_000_000,
  installedBytes: 10_000_000_000,
  sizeOnDisk: 0,
  ...over,
});

function settingsData(imagegen: ImageGenData): SettingsData {
  return {
    providers: [],
    presets: [],
    roles: {},
    limits: { maxUsdPerRun: 3, maxStepsPerRun: 40 },
    prices: {},
    appleHelper: false,
    probes: [],
    ingest: { cookiesFromBrowser: null },
    contact: null,
    imagegen,
  };
}

async function dialog(initial: ImageGenData = { models: [model()] }) {
  const box = { data: settingsData(initial), started: [] as [string, unknown][] };
  const t = await testEditor({
    handlers: {
      'settings.get': () => box.data,
      'jobs.start': ((kind: string, args: unknown) => {
        box.started.push([kind, args]);
        return 'job_img1';
      }) as never,
      'jobs.get': (() => ({ status: 'running', progress: 0 })) as never,
      'setup.status': () => {
        throw { code: 'NOT_AVAILABLE', message: 'no setup in this test', hint: '' };
      },
    },
  });
  render(
    <EditorProvider value={t.ctx}>
      <SettingsDialog onClose={() => undefined} focus={null} />
    </EditorProvider>,
  );
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return { t, box };
}

describe('Settings: local image generation', () => {
  it('shows size and licence first; nothing downloads until Download is pressed', async () => {
    const { box } = await dialog();
    const toggle = screen.getByLabelText(
      /Local image generation \(Z-Image-Turbo\)/,
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    const ask = screen.getByRole('alertdialog', { name: 'Download image model' });
    expect(ask.textContent).toMatch(/32\.8 GB/);
    expect(ask.textContent).toMatch(/10 GB stay on disk/);
    expect(ask.textContent).toMatch(/Apache-2\.0/);
    expect(box.started).toEqual([]);
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(box.started).toEqual([]);
  });

  it('Download starts imagegen.install, shows progress, and the switch turns on when it is done', async () => {
    const { t, box } = await dialog();
    fireEvent.click(screen.getByLabelText(/Local image generation/));
    fireEvent.click(screen.getByRole('button', { name: /^Download/ }));
    await waitFor(() =>
      expect(box.started).toEqual([['imagegen.install', { model: 'z-image-turbo' }]]),
    );
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    await act(async () => {
      t.fake.emit('job.progress', { jobId: 'job_img1', progress: 0.4, message: 'downloading' });
      await t.fake.settle();
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/40%.*downloading/));
    expect((screen.getByLabelText(/Local image generation/) as HTMLInputElement).disabled).toBe(
      true,
    );
    box.data = settingsData({
      models: [model({ installed: true, sizeOnDisk: 9_800_000_000 })],
    });
    await act(async () => {
      t.fake.emit('job.done', { jobId: 'job_img1', result: { model: 'z-image-turbo' } });
      await t.fake.settle();
    });
    await waitFor(() =>
      expect((screen.getByLabelText(/Local image generation/) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect(screen.getByText(/Installed, 9\.8 GB on disk/)).toBeTruthy();
  });

  it('a failed install shows the message and hint, and the switch stays off', async () => {
    const { t } = await dialog();
    fireEvent.click(screen.getByLabelText(/Local image generation/));
    fireEvent.click(screen.getByRole('button', { name: /^Download/ }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    await act(async () => {
      t.fake.emit('job.failed', {
        jobId: 'job_img1',
        error: {
          code: 'TOOL_FAILED',
          message: 'Not enough free disk space.',
          hint: 'Free some space.',
        },
      });
      await t.fake.settle();
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /Not enough free disk space\. Free some space\./,
      ),
    );
    expect((screen.getByLabelText(/Local image generation/) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('switching off asks first, then runs imagegen.remove', async () => {
    const { box } = await dialog({
      models: [model({ installed: true, sizeOnDisk: 9_800_000_000 })],
    });
    const toggle = screen.getByLabelText(/Local image generation/) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    const ask = screen.getByRole('alertdialog', { name: 'Remove image model' });
    expect(ask.textContent).toMatch(/free 9\.8 GB/);
    expect(box.started).toEqual([]);
    fireEvent.click(within(ask).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(box.started).toEqual([['imagegen.remove', { model: 'z-image-turbo' }]]),
    );
  });
});

describe('SettingsHost: image models', () => {
  it('lists both models from the engine, installed state and size on disk', async () => {
    const models = tmp('vox-imagegen-models');
    const host = new SettingsHost({
      cfg: configDeps(),
      appleHelper: false,
      imagegen: async () => ({ models: await imagegenStatus(models, {}) }),
    });
    const before = (await host.get()).imagegen!.models;
    expect(before.map((m) => [m.id, m.installed, m.license, m.gated])).toEqual([
      ['z-image-turbo', false, 'Apache-2.0', false],
      ['flux1-schnell', false, 'Apache-2.0', true],
    ]);
    mkdirSync(join(models, 'mflux', 'z-image-turbo'), { recursive: true });
    writeFileSync(join(models, 'mflux', 'z-image-turbo', 'vox-model.json'), '{}');
    writeFileSync(join(models, 'mflux', 'z-image-turbo', 'w.bin'), Buffer.alloc(4096));
    const after = (await host.get()).imagegen!.models[0]!;
    expect(after.installed).toBe(true);
    expect(after.sizeOnDisk).toBeGreaterThanOrEqual(4096);
    // without the dep the field is absent (the dialog hides the toggle)
    const bare = new SettingsHost({ cfg: configDeps(), appleHelper: false });
    expect((await bare.get()).imagegen).toBeUndefined();
  });
});
