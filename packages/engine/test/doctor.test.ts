// `vox doctor` checks (plan phase 04 step 13) with a fake exec: versions, fix lines for missing
// tools, the node-only yt-dlp warning, yt-dlp-ejs and impersonation, contact; project checks for
// caption-override orphans and --unlock.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { doctor, doctorProject, type Exec } from '../src/doctor.ts';
import type { Project } from '../src/model/schema.ts';
import { tempDir } from './helpers/store.ts';

const YTDLP_V = (runtimes: string, impersonate: boolean) =>
  [
    '[debug] Optional libraries: certifi-2026.02.25, curl_cffi-0.16.3 (unsupported), yt_dlp_ejs-0.8.0',
    `[debug] JS runtimes: ${runtimes}`,
    '[info] Available impersonate targets',
    `Chrome    -    curl_cffi${impersonate ? '' : ' (unavailable)'}`,
  ].join('\n');

function fakeExec(runtimes = 'deno-2.9.5', impersonate = false): Exec {
  return async (cmd, args) => {
    const name = cmd.split('/').at(-1)!;
    if (name === 'yt-dlp' && args.includes('-v'))
      return { code: 0, stdout: '', stderr: YTDLP_V(runtimes, impersonate) };
    const out: Record<string, string> = {
      ffmpeg: 'ffmpeg version 8.1.2 Copyright (c) 2000-2026',
      ffprobe: 'ffprobe version 8.1.2 Copyright (c) 2007-2026',
      'yt-dlp': '2026.07.04',
      deno: 'deno 2.9.5 (stable, release, aarch64-apple-darwin)',
      node: 'v24.14.0',
      uv: 'uv 0.11.19 (Homebrew 2026-09-01)',
    };
    return name in out
      ? { code: 0, stdout: `${out[name]}\n`, stderr: '' }
      : { code: -1, stdout: '', stderr: '' };
  };
}

const all = {
  ffmpeg: '/x/ffmpeg',
  ffprobe: '/x/ffprobe',
  'yt-dlp': '/x/yt-dlp',
  deno: '/x/deno',
  node: '/x/node',
  uv: '/x/uv',
};

const by = (r: { checks: { name: string; fix?: string }[] }, name: string) =>
  r.checks.find((c) => c.name === name);

describe('doctor', () => {
  test('all tools found: versions listed; impersonation missing is a warning, not an error', async () => {
    const r = await doctor({
      tools: all,
      config: { contact: 'me@example.org' },
      exec: fakeExec(),
      quick: true,
      home: tempDir(),
    });
    expect(by(r, 'ffmpeg')).toMatchObject({ level: 'ok', version: '8.1.2' });
    expect(by(r, 'yt-dlp')).toMatchObject({ level: 'ok', version: '2026.07.04' });
    expect(by(r, 'uv')).toMatchObject({ level: 'ok', version: '0.11.19' });
    expect(by(r, 'node')).toMatchObject({ level: 'ok', version: '24.14.0' });
    expect(by(r, 'yt-dlp-ejs')).toMatchObject({ level: 'ok', version: '0.8.0' });
    expect(by(r, 'yt-dlp-js-runtime')).toMatchObject({ level: 'ok' });
    expect(by(r, 'yt-dlp-impersonate')).toMatchObject({ level: 'warn' });
    expect(by(r, 'yt-dlp-impersonate')?.fix).toMatch(/curl/);
    expect(by(r, 'contact')).toMatchObject({ level: 'ok' });
    expect(r.ok).toBe(true);
  });

  test('a missing tool is an error with a fix line; deno missing only warns (node-only yt-dlp)', async () => {
    const tools = Object.fromEntries(
      Object.entries(all).filter(([k]) => k !== 'ffmpeg' && k !== 'deno'),
    );
    const r = await doctor({
      tools,
      config: {},
      exec: fakeExec('node-24.14.0'),
      quick: true,
      home: tempDir(),
    });
    expect(by(r, 'ffmpeg')).toMatchObject({ level: 'error', fix: 'brew install ffmpeg' });
    expect(by(r, 'deno')).toMatchObject({ level: 'warn' });
    expect(by(r, 'yt-dlp-js-runtime')).toMatchObject({ level: 'warn' });
    expect(by(r, 'contact')).toMatchObject({ level: 'warn' });
    expect(r.ok).toBe(false);
  });

  test('a tool that does not run is an error', async () => {
    const r = await doctor({
      tools: { ...all, uv: '/x/broken-uv' },
      config: {},
      exec: fakeExec(),
      quick: true,
      home: tempDir(),
    });
    expect(by(r, 'uv')).toMatchObject({ level: 'error', fix: 'brew install uv' });
  });

  test('the vendored Silero model SHA-256 is checked', async () => {
    const py = new URL('../../../py', import.meta.url).pathname;
    const r = await doctor({
      tools: { ...all, py },
      config: {},
      exec: fakeExec(),
      quick: true,
      home: tempDir(),
    });
    expect(by(r, 'model-silero-vad')).toMatchObject({ level: 'ok', licence: 'MIT' });
    const bad = tempDir();
    const r2 = await doctor({
      tools: { ...all, py: bad },
      config: {},
      exec: fakeExec(),
      quick: true,
      home: tempDir(),
    });
    expect(by(r2, 'model-silero-vad')).toMatchObject({ level: 'error' });
  });
});

describe('doctorProject', () => {
  const project = (overrides: { wordKey: string }[]): Project =>
    ({
      schemaVersion: 2,
      id: 'p_doc',
      name: 'doc',
      version: 1,
      media: [
        {
          id: 'm_a',
          kind: 'video',
          path: 'media/m_a.mp4',
          transcriptPath: 'transcripts/m_a.json',
          transcriptRev: 'rev1',
          origin: { type: 'upload' },
          tags: [],
        },
      ],
      sequences: [
        { id: 'seq_1', captions: { overrides: overrides.map((o) => ({ ...o, text: 'x' })) } },
      ],
      meta: { createdAt: '', updatedAt: '', sourceUrls: [] },
    }) as unknown as Project;

  test('reports overrides whose word is gone, and --unlock removes the lock', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'project.lock'),
      JSON.stringify({ pid: 1, host: 'other-mac', startedAt: 'x' }),
    );
    const p = project([
      { wordKey: 'm_a:rev1:0' },
      { wordKey: 'm_a:rev0:1' },
      { wordKey: 'm_gone:rev1:0' },
      { wordKey: 'm_a:rev1:9' },
    ]);
    const transcript = {
      language: 'en',
      words: [{ text: 'hi', startMs: 0, endMs: 100, kind: 'word' }],
      speechRegions: [],
    };
    const r = await doctorProject(dir, p, () => transcript as never);
    expect(r.orphanOverrides.map((o) => o.reason)).toEqual([
      'transcript changed',
      'media removed',
      'word missing',
    ]);
    expect(r.lock).toMatchObject({ host: 'other-mac' });
    expect(existsSync(join(dir, 'project.lock'))).toBe(true);
    const u = await doctorProject(dir, p, () => transcript as never, { unlock: true });
    expect(u.lock).toMatchObject({ removed: true });
    expect(existsSync(join(dir, 'project.lock'))).toBe(false);
  });
});
