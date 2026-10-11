import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { fileResponse, headersFor, parseRange, resolveInside } from '../electron/protocol.ts';

const root = mkdtempSync(path.join(tmpdir(), 'vox-proto-'));
mkdirSync(path.join(root, 'build', 'media'), { recursive: true });
writeFileSync(path.join(root, 'build', 'index.html'), '<!doctype html>');
writeFileSync(path.join(root, 'build', 'media', 'a.mp4'), Buffer.alloc(1000, 7));
writeFileSync(path.join(root, 'secret.txt'), 'x');
symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'build', 'link.txt'));
const build = path.join(root, 'build');

describe('path rule', () => {
  test('serves files inside the root', () => {
    expect(resolveInside(build, '/index.html')).toMatch(/index\.html$/);
    expect(resolveInside(build, '/media/a.mp4')).toMatch(/a\.mp4$/);
  });
  test('rejects .., encoded .., NUL, absolute, symlink escape, missing', () => {
    expect(resolveInside(build, '/../secret.txt')).toBeNull();
    expect(resolveInside(build, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveInside(build, '/media%2f..%2f..%2fsecret.txt')).toBeNull();
    expect(resolveInside(build, '/index.html%00')).toBeNull();
    expect(
      resolveInside(build, `/${encodeURIComponent(path.join(root, 'secret.txt'))}`),
    ).toBeNull();
    expect(resolveInside(build, '/link.txt')).toBeNull();
    expect(resolveInside(build, '/nope.html')).toBeNull();
    expect(resolveInside(build, '/')).toBeNull();
  });
  test('decodes once only', () => {
    expect(resolveInside(build, '/%252e%252e/secret.txt')).toBeNull();
  });
});

describe('range', () => {
  test('parses ranges', () => {
    expect(parseRange('bytes=0-0', 1000)).toEqual([0, 0]);
    expect(parseRange('bytes=10-', 1000)).toEqual([10, 999]);
    expect(parseRange('bytes=-100', 1000)).toEqual([900, 999]);
    expect(parseRange('bytes=0-5000', 1000)).toEqual([0, 999]);
    expect(parseRange('bytes=2000-', 1000)).toBeNull();
    expect(parseRange(null, 1000)).toBeNull();
  });
  test('responds 206 with Content-Range', async () => {
    const r = fileResponse(
      path.join(build, 'media', 'a.mp4'),
      new Request('vox-media://build/media/a.mp4', { headers: { Range: 'bytes=10-19' } }),
      null,
    );
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 10-19/1000');
    expect((await r.arrayBuffer()).byteLength).toBe(10);
  });
  test('416 for an unsatisfiable range', () => {
    const r = fileResponse(
      path.join(build, 'media', 'a.mp4'),
      new Request('vox-media://build/media/a.mp4', { headers: { Range: 'bytes=5000-' } }),
      null,
    );
    expect(r.status).toBe(416);
  });
});

describe('headers', () => {
  test('html gets the CSP, unknown types are attachments, all nosniff', () => {
    const h = headersFor('/x/index.html', 'CSP');
    expect(h.get('Content-Security-Policy')).toBe('CSP');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    const j = headersFor('/x/sequence.json', 'CSP');
    expect(j.get('Content-Disposition')).toBe('attachment');
    expect(j.get('Content-Security-Policy')).toBeNull();
  });
});
