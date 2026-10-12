// S4 (+ S33 argv part): yt-dlp argv snapshot. Config sourcing of `cookiesFromBrowser` (S33: only from
// the user's config) is wired by phase 04 ingest; here it is a plain parameter.

import { describe, expect, test } from 'vitest';
import { buildYtdlpArgs } from '../../src/stages/ytdlpArgs.ts';
import { VoxError } from '../../src/errors.ts';

const base = {
  url: 'https://www.instagram.com/reel/C1a2B3c4D5e/',
  proxyUrl: 'http://127.0.0.1:53111',
  outDir: '/tmp/vox-ingest-x',
  outputId: 'm_lq2x8k0a7f3b',
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof VoxError) return e.code;
    throw e;
  }
  return 'OK';
}

describe('buildYtdlpArgs (S4)', () => {
  test('default argv', () => {
    expect(buildYtdlpArgs(base)).toEqual([
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-playlist',
      '--playlist-items',
      '1',
      '--max-filesize',
      '4G',
      '-f',
      'bv*+ba/b',
      '-S',
      'res:1080,vcodec:h264',
      '--merge-output-format',
      'mp4',
      '--proxy',
      'http://127.0.0.1:53111',
      '-o',
      '/tmp/vox-ingest-x/m_lq2x8k0a7f3b.%(ext)s',
      '--',
      'https://www.instagram.com/reel/C1a2B3c4D5e/',
    ]);
  });

  test('--playlist drops --no-playlist and --playlist-items and numbers the outputs', () => {
    const argv = buildYtdlpArgs({ ...base, playlist: true });
    expect(argv).toEqual([
      '--ignore-config',
      '--no-plugin-dirs',
      '--max-filesize',
      '4G',
      '-f',
      'bv*+ba/b',
      '-S',
      'res:1080,vcodec:h264',
      '--merge-output-format',
      'mp4',
      '--proxy',
      'http://127.0.0.1:53111',
      '-o',
      '/tmp/vox-ingest-x/m_lq2x8k0a7f3b-%(playlist_index)s.%(ext)s',
      '--',
      'https://www.instagram.com/reel/C1a2B3c4D5e/',
    ]);
    expect(argv).not.toContain('--no-playlist');
    expect(argv).not.toContain('--playlist-items');
  });

  test('format sort: the 1080 cap comes first, then H.264 (D-78); the fallback format stays', () => {
    const argv = buildYtdlpArgs(base);
    const sort = argv[argv.indexOf('-S') + 1]!.split(',');
    expect(sort[0]).toBe('res:1080');
    expect(sort).toContain('vcodec:h264');
    expect(sort.indexOf('vcodec:h264')).toBeGreaterThan(sort.indexOf('res:1080'));
    expect(argv[argv.indexOf('-f') + 1]).toBe('bv*+ba/b');
    expect(argv.filter((a) => a === '-S')).toHaveLength(1);
  });

  test('cookies flag appears only when the setting is given (S33 argv part)', () => {
    expect(buildYtdlpArgs(base).join(' ')).not.toContain('--cookies');
    expect(buildYtdlpArgs({ ...base, cookiesFromBrowser: null }).join(' ')).not.toContain(
      '--cookies',
    );
    for (const browser of ['safari', 'chrome', 'firefox'] as const) {
      const argv = buildYtdlpArgs({ ...base, cookiesFromBrowser: browser });
      const i = argv.indexOf('--cookies-from-browser');
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe(browser);
      expect(i).toBeLessThan(argv.indexOf('--'));
    }
  });

  test('an unknown browser is refused (no free-form value reaches yt-dlp)', () => {
    expect(
      codeOf(() => buildYtdlpArgs({ ...base, cookiesFromBrowser: 'chrome:/etc/profile' as never })),
    ).toBe('VALIDATION');
  });

  test('node as the JS runtime adds --js-runtimes node; deno (default) adds nothing', () => {
    expect(buildYtdlpArgs(base)).not.toContain('--js-runtimes');
    expect(buildYtdlpArgs({ ...base, jsRuntime: 'deno' })).not.toContain('--js-runtimes');
    const argv = buildYtdlpArgs({ ...base, jsRuntime: 'node' });
    const i = argv.indexOf('--js-runtimes');
    expect(argv[i + 1]).toBe('node');
    expect(i).toBeLessThan(argv.indexOf('--'));
  });

  test('the URL is always last, after --, so it can never be read as an option', () => {
    const argv = buildYtdlpArgs({ ...base, url: 'https://example.com/--exec=x' });
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('https://example.com/--exec=x');
  });

  test('the URL passed is the one that was checked (parsed and normalised)', () => {
    const argv = buildYtdlpArgs({ ...base, url: '  https://YOUTU.BE/dQw4w9WgXcQ\n' });
    expect(argv.at(-1)).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  test('only http(s) URLs', () => {
    for (const url of ['ftp://x.test/a', 'file:///etc/passwd', 'ytsearch:cats', '-o /tmp/x', '']) {
      expect(
        codeOf(() => buildYtdlpArgs({ ...base, url })),
        url,
      ).toBe('URL_INVALID');
    }
  });

  test('the proxy must be the local filtering proxy', () => {
    for (const proxyUrl of [
      '',
      'socks5://127.0.0.1:1080',
      'http://10.0.0.1:8080',
      'http://proxy.example:8080',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://user:pw@127.0.0.1:8080',
      'http://127.0.0.1:8080/path',
    ]) {
      expect(
        codeOf(() => buildYtdlpArgs({ ...base, proxyUrl })),
        proxyUrl,
      ).toBe('VALIDATION');
    }
  });

  test('the output name is engine-generated: absolute folder + safe id, never a remote template', () => {
    expect(codeOf(() => buildYtdlpArgs({ ...base, outDir: 'relative/dir' }))).toBe('VALIDATION');
    for (const outputId of ['', '%(title)s', '../x', 'a/b', 'a b', '-x']) {
      expect(
        codeOf(() => buildYtdlpArgs({ ...base, outputId })),
        outputId,
      ).toBe('VALIDATION');
    }
    expect(codeOf(() => buildYtdlpArgs({ ...base, outDir: '/tmp/%(title)s' }))).toBe('VALIDATION');
  });
});
