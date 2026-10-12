// Final-render encoder (D-78): VideoToolbox (`--gpu` with a tuned `--video-bitrate`) on Apple
// silicon, libx264 elsewhere or when config / env forces software; a failed hardware render is
// rerun once in software, a cancel is not. A fake HyperFrames runner records its arguments.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  VT_BITS_PER_PIXEL,
  pickRenderEncoder,
  pictureRenderArgs,
  videotoolboxBitrate,
  type HyperframesRun,
  type RenderHost,
  type RenderedFile,
} from '../../src/api.ts';
import type { Config } from '../../src/config.ts';
import { VoxError } from '../../src/errors.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { exportEngine, exportProject } from '../export/project.ts';

const MAC: RenderHost = { platform: 'darwin', arch: 'arm64', env: {} };

describe('pickRenderEncoder', () => {
  test('VideoToolbox on Apple silicon only', () => {
    expect(pickRenderEncoder(MAC)).toBe('videotoolbox');
    expect(pickRenderEncoder({ ...MAC, setting: 'auto' })).toBe('videotoolbox');
    expect(pickRenderEncoder({ ...MAC, arch: 'x64' })).toBe('software');
    expect(pickRenderEncoder({ ...MAC, platform: 'linux' })).toBe('software');
    expect(pickRenderEncoder({ ...MAC, platform: 'win32', arch: 'x64' })).toBe('software');
  });

  test('config render.encoder=software or VOX_RENDER_ENCODER=software forces libx264', () => {
    expect(pickRenderEncoder({ ...MAC, setting: 'software' })).toBe('software');
    expect(pickRenderEncoder({ ...MAC, env: { VOX_RENDER_ENCODER: 'software' } })).toBe('software');
    expect(pickRenderEncoder({ ...MAC, env: { VOX_RENDER_ENCODER: 'other' } })).toBe(
      'videotoolbox',
    );
  });
});

describe('VideoToolbox bitrate and render args', () => {
  test('bitrate is width × height × fps × bits per pixel, in kbit/s', () => {
    const f30 = { num: 30, den: 1 };
    const std = Math.round((1080 * 1920 * 30 * VT_BITS_PER_PIXEL.standard) / 1000);
    expect(videotoolboxBitrate(1080, 1920, f30, 'standard')).toBe(`${std}k`);
    const ntsc = Math.round((1920 * 1080 * (30000 / 1001) * VT_BITS_PER_PIXEL.high) / 1000);
    expect(videotoolboxBitrate(1920, 1080, { num: 30000, den: 1001 }, 'high')).toBe(`${ntsc}k`);
    expect(VT_BITS_PER_PIXEL.draft).toBeLessThan(VT_BITS_PER_PIXEL.standard);
    expect(VT_BITS_PER_PIXEL.standard).toBeLessThan(VT_BITS_PER_PIXEL.high);
    // a tiny canvas still gets a sane floor
    expect(videotoolboxBitrate(16, 16, { num: 24, den: 1 }, 'draft')).toBe('500k');
  });

  test('--gpu and --video-bitrate only for the hardware path; quality is always passed', () => {
    const fps = { num: 30, den: 1 };
    const sw = pictureRenderArgs('/b', '/o.mp4', fps, 'standard');
    expect(sw).not.toContain('--gpu');
    expect(sw).not.toContain('--video-bitrate');
    const hw = pictureRenderArgs('/b', '/o.mp4', fps, 'standard', { bitrate: '5599k' });
    expect(hw.slice(0, sw.length)).toEqual(sw);
    expect(hw.slice(sw.length)).toEqual(['--gpu', '--video-bitrate', '5599k']);
    expect(hw).not.toContain('--crf');
  });
});

/** A fake render: writes a short test picture; `fail` decides whether this call fails. */
function fakeHf(calls: string[][], fail: (args: string[]) => VoxError | null): HyperframesRun {
  return async (args) => {
    calls.push(args);
    const err = fail(args);
    if (err) throw err;
    const dir = args[1]!;
    const out = args[args.indexOf('-o') + 1]!;
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const dur = Number(/data-duration="([\d.]+)"/.exec(html)?.[1] ?? '1');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=1080x1920:rate=30:duration=${dur}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      out,
    ]);
  };
}

const toolFailed = () =>
  new VoxError('TOOL_FAILED', 'hyperframes render failed (exit 1): encoder error', 'retry');

async function render(o: {
  host: RenderHost;
  config?: Config;
  fail?: (args: string[]) => VoxError | null;
}): Promise<{ calls: string[][]; info: JobInfo<{ files: RenderedFile[] }> }> {
  const calls: string[][] = [];
  const e = exportEngine({
    hyperframes: fakeHf(calls, o.fail ?? (() => null)),
    renderHost: o.host,
    config: async () => o.config ?? {},
  });
  const fx = await exportProject(e);
  const info = (await e.jobs.wait(
    e.jobs.start('render', { projectId: fx.projectId, quality: 'draft' }),
  )) as JobInfo<{ files: RenderedFile[] }>;
  return { calls, info };
}

describe('render job encoder (D-78)', () => {
  test('Apple silicon: one hardware render with the tuned bitrate', async () => {
    const { calls, info } = await render({ host: MAC });
    expect(info.status, JSON.stringify(info.error)).toBe('done');
    expect(calls).toHaveLength(1);
    const a = calls[0]!;
    expect(a).toContain('--gpu');
    expect(a[a.indexOf('--video-bitrate') + 1]).toBe(
      videotoolboxBitrate(1080, 1920, { num: 30, den: 1 }, 'draft'),
    );
    expect(info.result?.files[0]?.encoder).toBe('videotoolbox');
    expect(info.result?.files[0]?.encoderFallback).toBeUndefined();
  }, 60_000);

  test('a failed hardware render reruns once in software and says why', async () => {
    const { calls, info } = await render({
      host: MAC,
      fail: (args) => (args.includes('--gpu') ? toolFailed() : null),
    });
    expect(info.status, JSON.stringify(info.error)).toBe('done');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--gpu');
    expect(calls[1]).not.toContain('--gpu');
    expect(calls[1]).not.toContain('--video-bitrate');
    expect(info.result?.files[0]?.encoder).toBe('software');
    expect(info.result?.files[0]?.encoderFallback).toContain('encoder error');
  }, 60_000);

  test('when the software rerun fails too, the job fails (no third try)', async () => {
    const { calls, info } = await render({ host: MAC, fail: () => toolFailed() });
    expect(info.status).toBe('failed');
    expect(info.error?.code).toBe('TOOL_FAILED');
    expect(calls).toHaveLength(2);
  }, 60_000);

  test('a cancel during the hardware render is not retried', async () => {
    const { calls, info } = await render({
      host: MAC,
      fail: () => new VoxError('CANCELLED', 'The render was cancelled.', 'Render again'),
    });
    expect(info.status).not.toBe('done');
    expect(calls).toHaveLength(1);
  }, 60_000);

  test('config render.encoder=software, VOX_RENDER_ENCODER=software and other hosts use libx264', async () => {
    for (const o of [
      { host: MAC, config: { render: { encoder: 'software' as const } } },
      { host: { ...MAC, env: { VOX_RENDER_ENCODER: 'software' } } },
      { host: { platform: 'linux', arch: 'x64', env: {} } },
    ]) {
      const { calls, info } = await render(o);
      expect(info.status, JSON.stringify(info.error)).toBe('done');
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain('--gpu');
      expect(info.result?.files[0]?.encoder).toBe('software');
    }
  }, 120_000);
});
