// Ingest with real ffmpeg (slow tier; needs `bash packages/engine/test/fixtures/make.sh`):
// the talking-head seed in mp4/mov/webm, VFR → CFR copy, NTSC 30000/1001, proxies on and off,
// derived files (audio, thumbs sprite, peaks), and a link through the fake yt-dlp (post count,
// cache reuse).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MediaItemSchema, type MediaItem } from '../../src/model/schema.ts';
import { PEAKS_PER_SECOND } from '../../src/stages/media/derive.ts';
import { runTool } from '../../src/stages/media/run.ts';
import { ingest, type IngestEnv } from '../../src/stages/ingest.ts';
import { fixture, removeDir, tempDir } from '../media/helpers.ts';

const HEAD = fixture('assets/media/talking-head-20s.mp4');
const VFR = fixture('out/phone-vfr-20s.mp4');
const NTSC = fixture('out/ntsc-2997-20s.mp4');

let root = '';
beforeAll(() => {
  if (!existsSync(VFR) || !existsSync(NTSC)) {
    throw new Error(
      'Run `bash packages/engine/test/fixtures/make.sh` first (fixtures/out is generated).',
    );
  }
  root = tempDir('vox-ingest-slow-');
});
afterAll(() => removeDir(root));

let n = 0;
async function project(): Promise<string> {
  const dir = join(root, `p${n++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
const env = (projectDir: string, over: Partial<IngestEnv> = {}): IngestEnv => ({
  projectDir,
  existing: [],
  tools: {},
  docText: async () => {
    throw new Error('no docs here');
  },
  ...over,
});

async function probeSize(path: string): Promise<{ w: number; h: number }> {
  const { stdout } = await runTool('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    path,
  ]);
  const s = (JSON.parse(stdout) as { streams: { width: number; height: number }[] }).streams[0]!;
  return { w: s.width, h: s.height };
}

describe('ingest video (slow)', () => {
  test.each(['mp4', 'mov', 'webm'])(
    'talking-head .%s: proxy, audio, thumbs, peaks',
    async (ext) => {
      const dir = await project();
      const seen: number[] = [];
      const r = await ingest(env(dir, { progress: (p) => seen.push(p) }), {
        projectId: 'p',
        inputs: [fixture(`assets/media/talking-head-20s.${ext}`)],
      });
      const m = MediaItemSchema.parse(r.media[0]!.media);
      expect(m).toMatchObject({ kind: 'video', hasAudio: true, vfr: false });
      expect(m.durationMs).toBeGreaterThan(19_000);
      expect(m.durationMs).toBeLessThan(21_000);
      expect(m.loudness?.integratedLufs).toBeLessThan(0);
      for (const k of ['proxyPath', 'audioPath', 'thumbsPath', 'peaksPath'] as const) {
        expect(existsSync(join(dir, m[k]!)), k).toBe(true);
      }
      expect((await probeSize(join(dir, m.proxyPath!))).h).toBeLessThanOrEqual(540);
      const peaks = JSON.parse(await readFile(join(dir, m.peaksPath!), 'utf8')) as {
        peaks: number[];
      };
      expect(Math.abs(peaks.peaks.length - (m.durationMs! / 1000) * PEAKS_PER_SECOND)).toBeLessThan(
        PEAKS_PER_SECOND,
      );
      expect(Math.max(...peaks.peaks)).toBeGreaterThan(0.05);
      expect(seen.at(-1)).toBeGreaterThan(0.8);
    },
  );

  test('progress moves with each ffmpeg step (labels, never backwards)', async () => {
    const dir = await project();
    const seen: { p: number; m: string | undefined }[] = [];
    await ingest(env(dir, { progress: (p, m) => seen.push({ p, m }) }), {
      projectId: 'p',
      inputs: [HEAD],
    });
    const labels = new Set(seen.map((s) => s.m));
    for (const l of ['Analysing', 'Making proxy']) expect(labels).toContain(l);
    // Audio runs beside the proxy; the label names the costlier step, so audio may not show.
    const known = ['Analysing', 'Making proxy', 'Making thumbnails', 'Extracting audio'];
    for (const l of labels) expect(known).toContain(l);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.p).toBeGreaterThanOrEqual(seen[i - 1]!.p);
    // ffmpeg -progress reports inside the proxy step, not only at its end.
    const proxy = seen.filter((s) => s.m === 'Making proxy').map((s) => s.p);
    expect(new Set(proxy).size).toBeGreaterThan(2);
    expect(seen.at(-1)!.p).toBeGreaterThan(0.9);
  });

  test('phone VFR gets a CFR copy; the proxy is made from it', async () => {
    const dir = await project();
    const { media } = await ingest(env(dir), { projectId: 'p', inputs: [VFR] });
    const m = media[0]!.media;
    expect(m.vfr).toBe(true);
    expect(m.cfrPath).toBe(`media/${m.id}.cfr.mp4`);
    expect(existsSync(join(dir, m.cfrPath!))).toBe(true);
  });

  test('a failed hardware CFR encode falls back to libx264', async () => {
    const dir = await project();
    // ffmpeg that refuses h264_videotoolbox (a build that lists it on a machine without it).
    const bin = join(root, 'ffmpeg-no-vt');
    const real = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' });
    const ffmpeg = real.trim();
    await writeFile(
      bin,
      `#!/bin/sh\ncase "$*" in *h264_videotoolbox*-q:v*) echo no hardware >&2; exit 1 ;; esac\nexec '${ffmpeg}' "$@"\n`,
    );
    await chmod(bin, 0o755);
    const seen: (string | undefined)[] = [];
    const { media } = await ingest(
      env(dir, { tools: { ffmpeg: bin }, progress: (_p, m) => seen.push(m) }),
      { projectId: 'p', inputs: [VFR] },
    );
    const m = media[0]!.media;
    expect(m.cfrPath).toBe(`media/${m.id}.cfr.mp4`);
    const { stdout } = await runTool('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,r_frame_rate',
      '-of',
      'csv=p=0',
      join(dir, m.cfrPath!),
    ]);
    expect(stdout.trim()).toBe('h264,30000/1001');
    expect(seen).toContain('Converting frame rate');
  });

  test('NTSC keeps 30000/1001; proxies:false skips proxy, thumbs and peaks but keeps the m4a', async () => {
    const dir = await project();
    const { media } = await ingest(env(dir), { projectId: 'p', inputs: [NTSC], proxies: false });
    const m: MediaItem = media[0]!.media;
    expect(m.fps).toEqual({ num: 30000, den: 1001 });
    expect(m.proxyPath).toBeUndefined();
    expect(m.thumbsPath).toBeUndefined();
    expect(m.peaksPath).toBeUndefined();
    expect(m.audioPath).toBe(`audio/${m.id}.m4a`);
  });
});

describe('ingest links (slow, fake yt-dlp)', () => {
  test('a 3-item carousel takes the first video and reports the count; a rerun reuses it', async () => {
    const dir = await project();
    const log = join(root, 'yt.log');
    const e = env(dir, {
      tools: { 'yt-dlp': fixture('../helpers/fake-ytdlp.mjs') },
      env: {
        ...process.env,
        FAKE_YTDLP_LOG: log,
        FAKE_YTDLP_MODE: 'ok',
        FAKE_YTDLP_SOURCE: HEAD,
        FAKE_YTDLP_COUNT: '3',
      },
    });
    const url = 'https://www.instagram.com/p/DCarousel_1/';
    const a = await ingest(e, { projectId: 'p', inputs: [url] });
    expect(a.media).toHaveLength(1);
    expect(a.media[0]!.media).toMatchObject({
      kind: 'video',
      origin: { type: 'url', url },
    });
    expect(a.posts).toEqual([{ url, count: 3, taken: 1 }]);
    const b = await ingest(
      { ...e, existing: [a.media[0]!.media] },
      { projectId: 'p', inputs: [url] },
    );
    expect(b.media[0]).toMatchObject({ reused: true, media: { id: a.media[0]!.media.id } });
    expect(b.posts).toEqual([{ url, count: 3, taken: 1 }]);
    // yt-dlp ran once; the child got no proxy env vars besides what --proxy sets.
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { proxyEnv: string[] }).proxyEnv).toEqual([]);
  });
});
