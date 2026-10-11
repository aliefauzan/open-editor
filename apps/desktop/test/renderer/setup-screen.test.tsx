// @vitest-environment jsdom
// GATE 5 findings on the setup screen: a component that finished inside "Install all" still read
// "Not installed" until every component was done, and a download showed only a text line. Now a
// component's own `done` refreshes the status, each busy row has a progress bar (determinate when
// the size is known), and "Install all" counts finished components.
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupScreen } from '../../src/renderer/Setup.tsx';
import { useSetup } from '../../src/renderer/setup-store.ts';
import type { SetupComponentData, SetupStatusData } from '../../src/shared/api.ts';

const comp = (id: string, state: SetupComponentData['state']): SetupComponentData =>
  ({ id, label: id, kind: 'binary', licence: 'MIT', sizeBytes: 1e6, state }) as SetupComponentData;

const status = (states: Record<string, SetupComponentData['state']>): SetupStatusData =>
  ({
    components: Object.entries(states).map(([id, s]) => comp(id, s)),
    ffmpeg: { state: 'ok', version: '8', commands: [] },
    ready: false,
    done: false,
    disabledStages: {},
    update: { status: 'disabled' },
  }) as unknown as SetupStatusData;

afterEach(() => {
  cleanup();
  useSetup.setState({ status: null, installing: [], progress: {}, errors: {}, batch: [] });
  delete (window as unknown as { vox?: unknown }).vox;
});

describe('setup screen progress (GATE 5 findings)', () => {
  it('a component that reports done flips to Ready while "Install all" still runs', async () => {
    const statusFn = vi.fn(async () => status({ deno: 'ready', 'python-env': 'missing' }));
    (window as unknown as { vox: unknown }).vox = { setup: { status: statusFn } };
    useSetup.setState({
      status: status({ deno: 'missing', 'python-env': 'missing' }),
      installing: ['all'],
      batch: ['deno', 'python-env'],
    });
    render(<SetupScreen />);
    expect(within(screen.getByTestId('component-deno')).getByText('Not installed')).toBeTruthy();
    await act(async () => {
      useSetup.getState().onProgress({ type: 'setup.progress', component: 'deno', phase: 'done' });
      await Promise.resolve();
    });
    expect(statusFn).toHaveBeenCalled();
    expect(within(screen.getByTestId('component-deno')).getByText('Ready')).toBeTruthy();
    expect(screen.getByTestId('install-all').textContent).toBe('Installing… 1 of 2');
  });

  it('each busy row has a progress bar: a percentage when the size is known, else indeterminate', () => {
    useSetup.setState({
      status: status({ deno: 'missing', 'python-env': 'missing', 'yt-dlp': 'missing' }),
      installing: ['all'],
      batch: ['deno', 'python-env', 'yt-dlp'],
      progress: {
        deno: { phase: 'download', receivedBytes: 57, totalBytes: 100 },
        'python-env': { phase: 'sync', message: 'Downloaded onnxruntime' },
      },
    });
    render(<SetupScreen />);
    const deno = within(screen.getByTestId('component-deno')).getByRole('progressbar');
    expect(deno.getAttribute('aria-valuenow')).toBe('57');
    const py = within(screen.getByTestId('component-python-env')).getByRole('progressbar');
    expect(py.getAttribute('aria-valuenow')).toBeNull();
    // queued, nothing reported yet: says so instead of an empty line
    expect(within(screen.getByTestId('component-yt-dlp')).getByText('Waiting…')).toBeTruthy();
    expect(within(screen.getByTestId('component-yt-dlp')).queryByRole('progressbar')).toBeNull();
    // overall bar for "Install all"
    const all = screen.getByRole('progressbar', { name: 'Install all' });
    expect(all.getAttribute('aria-valuenow')).toBe('0');
  });
});
