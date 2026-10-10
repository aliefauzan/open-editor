// S6: media type from content, not extension; SVG/HTML never accepted as media. S5 (first layer):
// HLS playlists and concat lists disguised as `.mp4` are rejected before ffmpeg ever opens them.
// Every hostile file is generated in a temp folder by the test; real media is made with ffmpeg.

import { spawnSync } from 'node:child_process';
import { copyFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import { sniffBytes, sniffFile } from '../../src/stages/media/sniff.ts';
import { codeOfAsync, fixture, removeDir, tempDir } from './helpers.ts';

let dir = '';
const at = (name: string) => join(dir, name);

function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr)}`);
}

beforeAll(() => {
  dir = tempDir('vox-sniff-');
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5'];
  const pic = ['-f', 'lavfi', '-i', 'testsrc=s=64x48:d=1', '-frames:v', '1'];
  ffmpeg([...tone, at('tone.wav')]);
  ffmpeg([...tone, '-c:a', 'libmp3lame', at('tone.mp3')]);
  ffmpeg([...tone, '-c:a', 'aac', '-f', 'adts', at('tone.aac')]);
  ffmpeg([...tone, '-c:a', 'aac', at('tone.m4a')]);
  ffmpeg([...tone, '-c:a', 'libopus', at('tone.ogg')]);
  ffmpeg([...tone, '-c:a', 'flac', at('tone.flac')]);
  ffmpeg([...pic, at('pic.png')]);
  ffmpeg([...pic, at('pic.jpg')]);
  ffmpeg([...pic, at('pic.gif')]);
  // Homebrew's ffmpeg has no WebP encoder: a minimal RIFF/WEBP header is enough for the sniffer.
  writeFileSync(
    at('pic.webp'),
    Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([26, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(18),
    ]),
  );
  ffmpeg([...pic, '-c:v', 'mjpeg', '-f', 'avi', at('clip.avi')]);
});

afterAll(() => removeDir(dir));

describe('sniffFile: real media detected from content, whatever the extension (S6)', () => {
  test.each([
    ['assets/media/talking-head-20s.mp4', 'video', 'mov', 'mp4'],
    ['assets/media/talking-head-20s.mov', 'video', 'mov', 'mov'],
    ['assets/media/talking-head-20s.webm', 'video', 'matroska', 'webm'],
  ])('%s → %s/%s (.%s), also when renamed .png', async (rel, kind, format, ext) => {
    const want = { kind, format, ext };
    expect(await sniffFile(fixture(rel))).toEqual(want);
    copyFileSync(fixture(rel), at(`renamed-${ext}.png`));
    expect(await sniffFile(at(`renamed-${ext}.png`))).toEqual(want);
  });

  test.each([
    ['tone.wav', 'audio', 'wav', 'wav'],
    ['tone.mp3', 'audio', 'mp3', 'mp3'],
    ['tone.aac', 'audio', 'aac', 'aac'],
    ['tone.m4a', 'audio', 'mov', 'm4a'],
    ['tone.ogg', 'audio', 'ogg', 'ogg'],
    ['tone.flac', 'audio', 'flac', 'flac'],
    ['pic.png', 'image', 'png', 'png'],
    ['pic.jpg', 'image', 'jpeg', 'jpg'],
  ])('%s → %s/%s', async (name, kind, format, ext) => {
    expect(await sniffFile(at(name))).toEqual({ kind, format, ext });
    // The extension plays no part: the same bytes under a wrong name sniff the same.
    copyFileSync(at(name), at(`${name}.mp4`));
    expect(await sniffFile(at(`${name}.mp4`))).toEqual({ kind, format, ext });
  });

  test('a Matroska file (not WebM) is mkv', async () => {
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=64x48:d=0.2', '-c:v', 'mpeg4', at('clip.mkv')]);
    expect(await sniffFile(at('clip.mkv'))).toEqual({
      kind: 'video',
      format: 'matroska',
      ext: 'mkv',
    });
  });
});

describe('sniffFile: hostile files are rejected with MEDIA_UNSUPPORTED (S5, S6)', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>';
  const cases: [string, string, string][] = [
    ['SVG renamed .png', 'evil.png', svg],
    [
      'SVG with an XML prolog, BOM and whitespace, renamed .png',
      'evil2.png',
      `\uFEFF \n<?xml version="1.0"?>\n${svg}`,
    ],
    [
      'HTML renamed .mp4',
      'page.mp4',
      '<!DOCTYPE html><html><body><script>x()</script></body></html>',
    ],
    [
      'HTML fragment renamed .png',
      'frag.png',
      '  <script src="https://example.com/x.js"></script>',
    ],
    [
      'HLS playlist renamed .mp4',
      'hls.mp4',
      '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg.ts\n',
    ],
    ['concat list renamed .mp4', 'concat.mp4', "ffconcat version 1.0\nfile 'other.mp4'\n"],
    ['concat list without header renamed .mp4', 'list.mp4', "file '/etc/passwd'\n"],
    ['PLS playlist renamed .mp3', 'radio.mp3', '[playlist]\nFile1=http://example.com/a.mp3\n'],
    [
      'DASH manifest renamed .mp4',
      'dash.mp4',
      '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>',
    ],
    ['plain text renamed .mov', 'notes.mov', 'just some words'],
    ['an empty file', 'empty.mp4', ''],
  ];
  test.each(cases)('%s', async (_label, name, content) => {
    writeFileSync(at(name), content);
    expect(await codeOfAsync(sniffFile(at(name)))).toBe('MEDIA_UNSUPPORTED');
  });

  test('the error names what was found and the hint says which files work', async () => {
    writeFileSync(at('evil3.png'), svg);
    const err = await sniffFile(at('evil3.png')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoxError);
    const v = err as VoxError;
    expect(v.details).toMatchObject({ detected: 'svg' });
    expect(v.hint).toMatch(/MP4/);
  });

  test.each([
    ['hls.m3u8', '#EXTM3U\n', 'hls'],
    ['c.mp4', 'ffconcat version 1.0\n', 'concat'],
    ['p.html', '<html></html>', 'html'],
    ['x.xml', '<?xml version="1.0"?><smil/>', 'xml'],
  ])('%s is reported as %s', async (name, content, detected) => {
    writeFileSync(at(name), content);
    const err = (await sniffFile(at(name)).catch((e: unknown) => e)) as VoxError;
    expect(err.details).toMatchObject({ detected });
  });

  test.each([
    ['pic.gif', 'gif'],
    ['pic.webp', 'webp'],
    ['clip.avi', 'avi'],
  ])('unsupported binary format %s → MEDIA_UNSUPPORTED (%s)', async (name, detected) => {
    const err = (await sniffFile(at(name)).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('MEDIA_UNSUPPORTED');
    expect(err.details).toMatchObject({ detected });
  });

  test('random binary bytes → MEDIA_UNSUPPORTED', async () => {
    writeFileSync(at('noise.mp4'), Buffer.from([0, 1, 2, 3, 250, 251, 252, 0, 9, 9, 9, 9, 9]));
    expect(await codeOfAsync(sniffFile(at('noise.mp4')))).toBe('MEDIA_UNSUPPORTED');
  });

  test('HEIC (ISO BMFF image brand) is not taken for MP4 video', () => {
    const head = Buffer.alloc(32);
    head.writeUInt32BE(24, 0);
    head.write('ftypheic', 4, 'latin1');
    expect(() => sniffBytes(head, 'IMG_0001.HEIC')).toThrow(VoxError);
  });

  test('a folder is not media', async () => {
    expect(await codeOfAsync(sniffFile(dir))).toBe('MEDIA_UNSUPPORTED');
  });

  test.each([
    [
      'ftyp inside an HTML comment',
      'poly1.mp4',
      '<!--ftypisom--><html><script>x()</script></html>',
      'html',
    ],
    [
      'free atom inside an SVG comment',
      'poly2.mov',
      '<!--free--><svg xmlns="http://www.w3.org/2000/svg"/>',
      'svg',
    ],
    ['moov atom name in plain text', 'poly3.mov', 'abcdmoov and some words', 'plain text'],
    ['ID3 tag name in plain text', 'poly4.mp3', 'ID3 is a tag format', 'plain text'],
  ])(
    'a text polyglot with a media signature is not media: %s',
    async (_l, name, content, detected) => {
      writeFileSync(at(name), content);
      const err = (await sniffFile(at(name)).catch((e: unknown) => e)) as VoxError;
      expect(err.code).toBe('MEDIA_UNSUPPORTED');
      expect(err.details).toMatchObject({ detected });
    },
  );

  test('UTF-16 SVG (NUL bytes) is not media', async () => {
    writeFileSync(
      at('utf16.png'),
      Buffer.from('\uFEFF<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf16le'),
    );
    expect(await codeOfAsync(sniffFile(at('utf16.png')))).toBe('MEDIA_UNSUPPORTED');
  });

  test('an ftyp box with an impossible size or a non-ASCII brand is not media', () => {
    const head = Buffer.alloc(32);
    head.writeUInt32BE(5, 0);
    head.write('ftypisom', 4, 'latin1');
    expect(() => sniffBytes(head)).toThrow(VoxError);
    head.writeUInt32BE(24, 0);
    head[8] = 0x00;
    expect(() => sniffBytes(head)).toThrow(VoxError);
  });

  test('an MPEG sync word with a reserved bitrate or sample rate is not MP3', () => {
    const frame = (b2: number) => Buffer.from([0xff, 0xfb, b2, 0x00, 0x00, 0x01, 0x80, 0x00]);
    expect(sniffBytes(frame(0x90))).toMatchObject({ format: 'mp3' }); // 128 kb/s, 44.1 kHz
    expect(() => sniffBytes(frame(0xf0))).toThrow(VoxError); // bitrate index 15
    expect(() => sniffBytes(frame(0x9c))).toThrow(VoxError); // sample-rate index 3
  });

  test('a symbolic link is not followed', async () => {
    symlinkSync(at('tone.wav'), at('link.wav'));
    const err = (await sniffFile(at('link.wav')).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('MEDIA_UNSUPPORTED');
    expect(err.details).toMatchObject({ detected: 'a symbolic link' });
  });
});

describe('sniffFile: documents', () => {
  test.each([
    ['notes.txt', 'Hello there.\nSecond line.', 'txt'],
    ['script.md', '# Title\n\nSome *markdown*, even <b>inline</b> tags.', 'md'],
    ['play.fountain', 'INT. HOUSE - DAY\n\nJANE\nHello.', 'fountain'],
  ])('%s is a text document', async (name, content, ext) => {
    writeFileSync(at(name), content);
    expect(await sniffFile(at(name))).toEqual({ kind: 'document', format: 'text', ext });
  });

  test('a PDF is a document from its content', async () => {
    writeFileSync(at('doc.pdf'), '%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
    expect(await sniffFile(at('doc.pdf'))).toEqual({ kind: 'document', format: 'pdf', ext: 'pdf' });
  });

  test('HTML or SVG named .md or .txt is still rejected', async () => {
    writeFileSync(at('page.md'), '<!doctype html><html><body>hi</body></html>');
    writeFileSync(at('pic.txt'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await codeOfAsync(sniffFile(at('page.md')))).toBe('MEDIA_UNSUPPORTED');
    expect(await codeOfAsync(sniffFile(at('pic.txt')))).toBe('MEDIA_UNSUPPORTED');
  });

  test('a note that mentions <svg> or <script> in its body is still a document', async () => {
    writeFileSync(
      at('howto.md'),
      '# Embeds\n\nUse <script src="x.js"></script> or an <svg width="1"> tag.\n',
    );
    expect(await sniffFile(at('howto.md'))).toEqual({
      kind: 'document',
      format: 'text',
      ext: 'md',
    });
  });

  test('a pure-ASCII PDF is a PDF, not text', () => {
    expect(sniffBytes(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'))).toEqual({
      kind: 'document',
      format: 'pdf',
      ext: 'pdf',
    });
  });

  test('binary content named .txt is rejected', async () => {
    writeFileSync(at('bin.txt'), Buffer.from([0x41, 0x00, 0x42, 0xff, 0xfe]));
    expect(await codeOfAsync(sniffFile(at('bin.txt')))).toBe('MEDIA_UNSUPPORTED');
  });
});
