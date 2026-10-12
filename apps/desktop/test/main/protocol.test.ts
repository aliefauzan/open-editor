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
  resolveMediaPathSettled,
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

  it('a build file missing during a build swap is found again; other misses answer at once', async () => {
    const dir = join(root, 'Projects', 'p_test', 'build', 'seq_swap');
    const url = 'vox-media://p/p_test/build/seq_swap/audio/a.m4a';
    expect(await resolveMediaPath(url, ctx)).toBeNull();
    // the folder comes back while the first wait runs (as after the second rename of writeBuildTo)
    setTimeout(() => {
      mkdirSync(join(dir, 'audio'), { recursive: true });
      writeFileSync(join(dir, 'audio', 'a.m4a'), 'x');
    }, 5);
    expect(await resolveMediaPathSettled(url, ctx, [40, 40])).toBe(join(dir, 'audio', 'a.m4a'));
    const t0 = Date.now();
    expect(await resolveMediaPathSettled('vox-media://p/p_test/nope.txt', ctx, [500])).toBeNull();
    expect(await resolveMediaPathSettled('vox-media://p/p_test/../x', ctx, [500])).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
    expect(
      await resolveMediaPathSettled('vox-media://p/p_test/build/seq_main/gone.mp4', ctx, [1, 1]),
    ).toBeNull();
  });

  it('rejects a raw ".." that skipped URL normalisation', async () => {
    expect(
      await resolveMediaPath({ host: 'p', pathname: '/p_test/../../secret.txt' }, ctx),
    ).toBeNull();
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

  it('an extracted style report and its frames are served with the media CSP (phase 15)', async () => {
    const dir = join(root, 'styles', 'my-ref', 'report');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'styles', 'my-ref', 'report.html'), '<!doctype html><p>report</p>');
    writeFileSync(join(dir, 'ref-01.jpg'), Buffer.alloc(10, 1));
    const html = await resolveMediaPath('vox-media://styles/my-ref/report.html', ctx);
    expect(html).toBe(join(root, 'styles', 'my-ref', 'report.html'));
    const r = fileResponse(html!, new Request('vox-media://styles/my-ref/report.html'), CSP_MEDIA);
    expect(r.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
    expect(r.headers.get('Content-Disposition')).toBeNull();
    expect(await resolveMediaPath('vox-media://styles/my-ref/report/ref-01.jpg', ctx)).toBe(
      join(dir, 'ref-01.jpg'),
    );
    expect(CSP_APP).toContain('frame-src vox-media:');
  });

  it('non-media types are attachments with nosniff', () => {
    const r = fileResponse(
      join(ctx.projectsDir, 'p_test', 'project.json'),
      new Request('vox-media://p/x'),
      CSP_MEDIA,
    );
    expect(r.headers.get('Content-Disposition')).toBe('attachment');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('only fonts carry a CORS header (opaque-origin builds load fonts in CORS mode, D-37)', () => {
    expect(headersFor('a/Inter.ttf', CSP_MEDIA).get('Access-Control-Allow-Origin')).toBe('*');
    expect(headersFor('a/x.woff2', CSP_MEDIA).get('Access-Control-Allow-Origin')).toBe('*');
    for (const f of ['a/index.html', 'a/project.json', 'a/clip.mp4', 'a/app.js', 'a/x.png']) {
      expect(headersFor(f, CSP_MEDIA).get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('range requests return 206 with Content-Range', async () => {
    const f = join(ctx.projectsDir, 'p_test', 'build', 'seq_main', 'clip.mp4');
    const r = fileResponse(
      f,
      new Request('vox-media://p/x', { headers: { Range: 'bytes=10-19' } }),
      CSP_MEDIA,
    );
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 10-19/1000');
    expect(r.headers.get('Content-Type')).toBe('video/mp4');
    expect((await r.arrayBuffer()).byteLength).toBe(10);
    const bad = fileResponse(
      f,
      new Request('vox-media://p/x', { headers: { Range: 'bytes=2000-' } }),
      CSP_MEDIA,
    );
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
