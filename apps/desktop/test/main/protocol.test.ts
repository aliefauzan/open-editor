// S1, S13, S28: `vox-media://` path rule, headers and ranges; `vox-app://` CSP (pure handler parts).
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CSP_APP,
  CSP_MEDIA,
  fileResponse,
  headersFor,
  parseRange,
  resolveAppPath,
  resolveMediaPath,
} from '../../src/main/protocol.ts';

let root: string;
let ctx: { projectsDir: string; stylesDirs: string[] };

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vox-proto-')));
  const p = join(root, 'Projects', 'p_test');
  mkdirSync(join(p, 'build', 'seq_main'), { recursive: true });
  writeFileSync(join(p, 'build', 'seq_main', 'index.html'), '<!doctype html><p>hi</p>');
  writeFileSync(join(p, 'build', 'seq_main', 'clip.mp4'), Buffer.alloc(1000, 7));
  writeFileSync(join(p, 'project.json'), '{}');
  writeFileSync(join(root, 'secret.txt'), 'outside');
  symlinkSync(join(root, 'secret.txt'), join(p, 'build', 'link.txt'));
  mkdirSync(join(root, 'styles', 'base'), { recursive: true });
  writeFileSync(join(root, 'styles', 'base', 'style.json'), '{}');
  mkdirSync(join(root, 'renderer'));
  writeFileSync(join(root, 'renderer', 'index.html'), '<!doctype html>');
  ctx = { projectsDir: join(root, 'Projects'), stylesDirs: [join(root, 'styles')] };
});

describe('vox-media:// path rule (S1 through the protocol)', () => {
  it('serves files inside a project and a style', async () => {
    expect(await resolveMediaPath('vox-media://p/p_test/build/seq_main/index.html', ctx)).toBe(
      join(root, 'Projects', 'p_test', 'build', 'seq_main', 'index.html'),
    );
    expect(await resolveMediaPath('vox-media://styles/base/style.json', ctx)).toBe(
      join(root, 'styles', 'base', 'style.json'),
    );
  });

  it.each([
    ['encoded ..', 'vox-media://p/p_test/build/%2e%2e/%2e%2e/secret.txt'],
    ['encoded slash ..', 'vox-media://p/p_test/build%2f..%2f..%2fsecret.txt'],
    ['double encoded', 'vox-media://p/p_test/%252e%252e/secret.txt'],
    ['absolute', 'vox-media://p/p_test//etc/passwd'],
    ['NUL', 'vox-media://p/p_test/project.json%00.html'],
    ['symlink out', 'vox-media://p/p_test/build/link.txt'],
    ['bad project id', 'vox-media://p/..%2fp_test/project.json'],
    ['unknown host', 'vox-media://evil/p_test/project.json'],
    ['style escape', 'vox-media://styles/..%2f..%2fsecret.txt'],
    ['missing file', 'vox-media://p/p_test/nope.html'],
  ])('rejects %s', async (_l, url) => {
    expect(await resolveMediaPath(url, ctx)).toBeNull();
  });

  it('rejects a raw ".." that skipped URL normalisation', async () => {
    expect(await resolveMediaPath({ host: 'p', pathname: '/p_test/../../secret.txt' }, ctx)).toBeNull();
  });
});

describe('headers (S13, S28)', () => {
  it('HTML gets the media CSP with connect-src none and frame-ancestors vox-app:', async () => {
    const f = join(ctx.projectsDir, 'p_test', 'build', 'seq_main', 'index.html');
    const r = fileResponse(f, new Request('vox-media://p/x'), CSP_MEDIA);
    const csp = r.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('frame-ancestors vox-app:');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Disposition')).toBeNull();
  });

  it('non-media types are attachments with nosniff', () => {
    const r = fileResponse(join(ctx.projectsDir, 'p_test', 'project.json'), new Request('vox-media://p/x'), CSP_MEDIA);
    expect(r.headers.get('Content-Disposition')).toBe('attachment');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('only fonts carry a CORS header (opaque-origin builds load fonts in CORS mode, D-XX)', () => {
    expect(headersFor('a/Inter.ttf', CSP_MEDIA).get('Access-Control-Allow-Origin')).toBe('*');
    expect(headersFor('a/x.woff2', CSP_MEDIA).get('Access-Control-Allow-Origin')).toBe('*');
    for (const f of ['a/index.html', 'a/project.json', 'a/clip.mp4', 'a/app.js', 'a/x.png']) {
      expect(headersFor(f, CSP_MEDIA).get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('range requests return 206 with Content-Range', async () => {
    const f = join(ctx.projectsDir, 'p_test', 'build', 'seq_main', 'clip.mp4');
    const r = fileResponse(f, new Request('vox-media://p/x', { headers: { Range: 'bytes=10-19' } }), CSP_MEDIA);
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 10-19/1000');
    expect(r.headers.get('Content-Type')).toBe('video/mp4');
    expect((await r.arrayBuffer()).byteLength).toBe(10);
    const bad = fileResponse(f, new Request('vox-media://p/x', { headers: { Range: 'bytes=2000-' } }), CSP_MEDIA);
    expect(bad.status).toBe(416);
    expect(parseRange('bytes=-100', 1000)).toEqual([900, 999]);
  });

  it('the app CSP carries frame-ancestors none and blocks remote connections', () => {
    expect(CSP_APP).toContain("frame-ancestors 'none'");
    expect(CSP_APP).toContain("connect-src 'self'");
    expect(CSP_APP).toContain('frame-src vox-media:');
    expect(CSP_APP).not.toMatch(/https?:/);
  });
});

describe('vox-app:// files', () => {
  it('serves bundled files only from the renderer folder', async () => {
    const dir = join(root, 'renderer');
    expect(await resolveAppPath('vox-app://app/index.html', dir)).toBe(join(dir, 'index.html'));
    expect(await resolveAppPath('vox-app://app/', dir)).toBe(join(dir, 'index.html'));
    expect(await resolveAppPath('vox-app://app/%2e%2e/secret.txt', dir)).toBeNull();
    expect(await resolveAppPath('vox-app://other/index.html', dir)).toBeNull();
  });
});
