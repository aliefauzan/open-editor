// Real yt-dlp, no internet: recorded info JSON (format choice, carousel) and a download from a local
// server through the filtering proxy (fake resolver + dial). Local tier: skipped on CI.
import { spawnSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { resolveToolPaths } from '../../src/tools.ts';
import { downloadWithYtdlp } from '../../src/stages/ytdlp.ts';
import { buildYtdlpArgs } from '../../src/stages/ytdlpArgs.ts';

const FIX = fileURLToPath(new URL('../fixtures/ytdlp/', import.meta.url));
const SOURCE = fileURLToPath(
  new URL('../fixtures/assets/media/talking-head-20s.mp4', import.meta.url),
);
const tools = resolveToolPaths({ toolsDir: join(tmpdir(), 'vox-no-tools'), env: process.env });
const ytdlp = tools['yt-dlp'];

/** The engine's flags for `url`, without output and URL, plus offline info-JSON loading. */
function simulate(infoJson: string, playlist = false): Record<string, unknown> {
  const args = buildYtdlpArgs({
    url: 'https://www.instagram.com/p/DCarousel/',
    proxyUrl: 'http://127.0.0.1:9', // nothing listens: any network use fails
    outDir: tmpdir(),
    outputId: 'm_sim',
    playlist,
  });
  const cut = args.indexOf('--');
  const flags = args.slice(0, cut).filter((_, i, a) => a[i] !== '-o' && a[i - 1] !== '-o');
  const r = spawnSync(
    ytdlp!,
    [
      ...flags,
      '--no-update',
      '--no-clean-info-json',
      '--load-info-json',
      join(FIX, infoJson),
      '--simulate',
      '-j',
    ],
    { encoding: 'utf8' },
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n')[0]!) as Record<string, unknown>;
}

describe.skipIf(!ytdlp)('yt-dlp offline (D-13)', () => {
  test('vertical reel: the 1080×1920 stream + audio is chosen (not 1440×2560, not 720p)', () => {
    const j = simulate('reel-1080x1920.info.json');
    expect(j['format_id']).toBe('dash-1080+dash-a');
    expect([j['width'], j['height']]).toEqual([1080, 1920]);
  });

  test('carousel: only the first video is taken and the count is 3', () => {
    const j = simulate('carousel-3.info.json');
    expect(j['id']).toBe('DCarousel_1');
    expect(j['playlist_count']).toBe(3);
  });

  test('download from a local server through the filtering proxy', async () => {
    const size = statSync(SOURCE).size;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(size) });
      if (req.method === 'HEAD') return res.end();
      createReadStream(SOURCE).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), 'vox-ytdlp-dl-'));
    const progress: number[] = [];
    try {
      const report = await downloadWithYtdlp({
        url: 'http://video.test/clip.mp4',
        outDir: dir,
        outputId: 'm_dl',
        tools,
        net: {
          resolver: async () => ['93.184.216.34'],
          dial: () => ({ host: '127.0.0.1', port }),
        },
        onProgress: (p) => progress.push(p),
      });
      expect(report.files).toHaveLength(1);
      expect(report.files[0]!.filepath).toBe(join(dir, 'm_dl.mp4'));
      expect(statSync(report.files[0]!.filepath).size).toBe(size);
      expect(report.count).toBe(1);
      expect(progress.at(-1)).toBe(1);
    } finally {
      server.close();
    }
  });
});
