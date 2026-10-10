import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.ts';
import { withRetry } from '../../src/net/retry.ts';
import {
  LOGIN_REQUIRED_HINT,
  YTDLP_FAILED_HINT,
  downloadWithYtdlp,
  isLoginWall,
  jsRuntimeFor,
  parseProgressLine,
  parseYtdlpReport,
  ytdlpEnv,
  ytdlpFailure,
} from '../../src/stages/ytdlp.ts';

const FIX = fileURLToPath(new URL('../fixtures/ytdlp/', import.meta.url));
const FAKE = fileURLToPath(new URL('../helpers/fake-ytdlp.mjs', import.meta.url));
const SOURCE = fileURLToPath(new URL('../fixtures/assets/media/talking-head-20s.mp4', import.meta.url));
const stderrOf = (f: string) => readFile(join(FIX, f), 'utf8');
const toolFailed = (cause: string) =>
  new VoxError('TOOL_FAILED', 'yt-dlp failed (exit code 1).', 'x', { cause });

describe('LOGIN_REQUIRED mapping (D-13)', () => {
  test.each([
    ['instagram-login.stderr.txt', 'https://www.instagram.com/p/DPrivate0001/', 'instagram'],
    ['tiktok-private.stderr.txt', 'https://www.tiktok.com/@someone/video/7400000000000000001', 'tiktok'],
    ['instagram-rate-limit.stderr.txt', 'https://www.instagram.com/reel/DRate000001/', 'instagram'],
  ])('%s → LOGIN_REQUIRED with the spec hint', async (file, url, source) => {
    const err = ytdlpFailure(toolFailed(await stderrOf(file)), url, []) as VoxError;
    expect(err.code).toBe('LOGIN_REQUIRED');
    expect(err.hint).toBe(LOGIN_REQUIRED_HINT);
    expect(err.details).toEqual({ source });
  });

  test.each(['unsupported.stderr.txt', 'youtube-503.stderr.txt'])(
    '%s stays TOOL_FAILED with the local-file hint (step 14)',
    async (file) => {
      const err = ytdlpFailure(toolFailed(await stderrOf(file)), 'https://example.com/page', []) as VoxError;
      expect(err.code).toBe('TOOL_FAILED');
      expect(err.hint).toBe(YTDLP_FAILED_HINT);
      expect(err.hint).toMatch(/local|file/);
    },
  );

  test('only ERROR lines count', () => {
    expect(isLoginWall('WARNING: this is a private playlist\nERROR: Unsupported URL')).toBe(false);
  });

  test('a refused private address wins over the stderr text', () => {
    const err = ytdlpFailure(toolFailed('ERROR: Unable to download'), 'https://example.com/x', [
      { host: 'evil.test', port: 443, code: 'NET_BLOCKED', address: '10.0.0.1' },
    ]) as VoxError;
    expect(err.code).toBe('NET_BLOCKED');
  });

  test('other errors pass through unchanged', () => {
    const e = new VoxError('CANCELLED', 'x', 'y');
    expect(ytdlpFailure(e, 'https://example.com', [])).toBe(e);
  });
});

describe('yt-dlp helpers', () => {
  test('js runtime: deno when present, else node', () => {
    expect(jsRuntimeFor({ deno: '/x/deno' })).toBe('deno');
    expect(jsRuntimeFor({})).toBe('node');
  });

  test('proxy variables are removed from the child env', () => {
    const env = ytdlpEnv({ PATH: '/bin', HTTPS_PROXY: 'x', http_proxy: 'y', ALL_PROXY: 'z', NO_PROXY: '*' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  test('report and progress parsing', () => {
    const r = parseYtdlpReport(
      'noise\nvox-result {"filepath":"/a/m.mp4","id":"x","width":1080,"height":1920,"playlist_count":3}\nvox-result {bad\n',
    );
    expect(r).toEqual({ files: [{ filepath: '/a/m.mp4', id: 'x', width: 1080, height: 1920 }], count: 3 });
    expect(parseProgressLine('vox-progress 25 100')).toBe(0.25);
    expect(parseProgressLine('vox-progress 25 NA')).toBeUndefined();
  });

  test('withRetry: 3 retries with 1/2/4 s backoff, final errors stop at once', async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw toolFailed('x');
        },
        { retryable: () => true, sleep: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new VoxError('LOGIN_REQUIRED', 'x', 'y');
        },
        { retryable: (e) => (e as VoxError).code === 'TOOL_FAILED', sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('downloadWithYtdlp with a fake yt-dlp', () => {
  async function run(mode: string, extra: Partial<Parameters<typeof downloadWithYtdlp>[0]> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'vox-ytdlp-'));
    const logFile = join(dir, 'log.jsonl');
    const progress: number[] = [];
    const waits: number[] = [];
    const res = await downloadWithYtdlp({
      url: 'https://www.instagram.com/reel/DReel1080/',
      outDir: dir,
      outputId: 'm_test',
      tools: { 'yt-dlp': FAKE, deno: '/opt/x/deno' },
      env: {
        ...process.env,
        HTTPS_PROXY: 'http://corp.invalid:3128',
        FAKE_YTDLP_LOG: logFile,
        FAKE_YTDLP_MODE: mode,
        FAKE_YTDLP_SOURCE: SOURCE,
        FAKE_YTDLP_COUNTER: join(dir, 'n'),
        FAKE_YTDLP_COUNT: '3',
      },
      onProgress: (p) => progress.push(p),
      sleep: async (ms) => void waits.push(ms),
      ...extra,
    }).catch((e: unknown) => e);
    const calls = (await readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; proxyEnv: string[] });
    return { res, calls, progress, waits, dir };
  }

  test('passes the filtering proxy, no proxy env, report flags before --; first item + count', async () => {
    const { res, calls, progress } = await run('ok');
    const { args, proxyEnv } = calls[0]!;
    expect(proxyEnv).toEqual([]);
    expect(args[args.indexOf('--proxy') + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(args.slice(-2)).toEqual(['--', 'https://www.instagram.com/reel/DReel1080/']);
    expect(args.indexOf('--no-simulate')).toBeLessThan(args.indexOf('--'));
    expect(args).toContain('--playlist-items');
    expect(args).not.toContain('--js-runtimes');
    expect(args).not.toContain('--cookies-from-browser');
    expect(res).toMatchObject({ count: 3, files: [{ filepath: expect.stringMatching(/m_test\.mp4$/) }] });
    expect(progress).toContain(1);
  });

  test('cookies opt-in and node runtime appear only when given', async () => {
    const { calls } = await run('ok', {
      cookiesFromBrowser: 'firefox',
      tools: { 'yt-dlp': FAKE },
    });
    const { args } = calls[0]!;
    expect(args.slice(args.indexOf('--cookies-from-browser'), args.indexOf('--cookies-from-browser') + 2)).toEqual([
      '--cookies-from-browser',
      'firefox',
    ]);
    expect(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2)).toEqual([
      '--js-runtimes',
      'node',
    ]);
  });

  test('a login wall fails at once with LOGIN_REQUIRED (no retry)', async () => {
    const { res, calls } = await run(`stderr:${join(FIX, 'instagram-login.stderr.txt')}`);
    expect((res as VoxError).code).toBe('LOGIN_REQUIRED');
    expect(calls).toHaveLength(1);
  });

  test('a plain failure is retried with backoff, then succeeds', async () => {
    const f = join(FIX, 'youtube-503.stderr.txt');
    const { res, calls, waits } = await run(`stderr:${f},stderr:${f},ok`);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect((res as { count: number }).count).toBe(3);
  });

  test('gives up after 3 retries with the local-file hint', async () => {
    const f = join(FIX, 'youtube-503.stderr.txt');
    const { res, calls } = await run(`stderr:${f}`);
    expect(calls).toHaveLength(4);
    expect((res as VoxError).code).toBe('TOOL_FAILED');
    expect((res as VoxError).hint).toBe(YTDLP_FAILED_HINT);
  });
});
