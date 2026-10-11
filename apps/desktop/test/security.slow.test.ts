// Phase 08 security tests against the built app (app spec "Testing", main / engine-host; R4 S1,
// S10–S15, S28). Run: pnpm -C apps/desktop test:slow -- security
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, tempHome } from './helpers/app.ts';
import { engineAt, hostileProject } from './helpers/fixture.ts';

type Hooks = {
  log: { blocked: string[]; external: string[]; permissions: string[] };
  webPreferences(): Record<string, unknown>[];
  callAs(frame: unknown, method: string, args: unknown[]): Promise<{ ok: boolean; error?: { code: string } }>;
};

let app: ElectronApplication;
let page: Page;
let projectId: string;
let consoleErrors: string[];

beforeAll(async () => {
  const t = tempHome('vox-sec-');
  projectId = await hostileProject(engineAt(t.projectsDir, t.home));
  ({ app, page, consoleErrors } = await launchApp(t));
});

afterAll(async () => {
  await app?.close();
});

const mediaFetch = (url: string, headers: Record<string, string> = {}) =>
  app.evaluate(
    async ({ session }, a) => {
      const r = await session.defaultSession.fetch(a.url, { headers: a.headers });
      return { status: r.status, headers: Object.fromEntries(r.headers), size: (await r.arrayBuffer()).byteLength };
    },
    { url, headers },
  );

describe('window (S10, S28)', () => {
  it('every window has the security webPreferences', async () => {
    const prefs = await app.evaluate(() => (globalThis as unknown as { __voxTest: Hooks }).__voxTest.webPreferences());
    expect(prefs.length).toBeGreaterThan(0);
    for (const p of prefs) {
      expect(p).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
      });
    }
  });

  it('the page is vox-app://app and its response carries the app CSP with frame-ancestors none', async () => {
    expect(page.url()).toBe('vox-app://app/index.html');
    const r = await mediaFetch('vox-app://app/index.html');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('navigation is denied; window.open is denied; only allowlisted links reach the browser', async () => {
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const opened = await page.evaluate(() => [
      window.open('https://github.com/') === null,
      window.open('https://evil.example/') === null,
    ]);
    expect(opened).toEqual([true, true]);
    await page.evaluate(() => {
      location.href = 'https://evil.example/nav';
    });
    await page.evaluate(() => {
      location.href = 'https://creativecommons.org/licenses/';
    });
    await page.waitForTimeout(500);
    expect(page.url()).toBe('vox-app://app/index.html');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before);
    const log = await app.evaluate(() => (globalThis as unknown as { __voxTest: Hooks }).__voxTest.log);
    expect(log.external).toEqual(['https://github.com/', 'https://creativecommons.org/licenses/']);
  });
});

describe('network and permissions (S12, S15)', () => {
  it('renderer http(s) requests are blocked', async () => {
    const r = await page.evaluate(async () => {
      const out: string[] = [];
      for (const u of ['https://example.com/', 'http://127.0.0.1:9/']) {
        try {
          await fetch(u);
          out.push('ok');
        } catch {
          out.push('blocked');
        }
      }
      return out;
    });
    expect(r).toEqual(['blocked', 'blocked']);
    // the session blocks http(s) too, independent of the page CSP (webRequest)
    const viaSession = await app.evaluate(({ session }) =>
      session.defaultSession.fetch('https://example.com/session-probe').then(
        () => 'ok',
        () => 'blocked',
      ),
    );
    expect(viaSession).toBe('blocked');
    const log = await app.evaluate(() => (globalThis as unknown as { __voxTest: Hooks }).__voxTest.log);
    expect(log.blocked).toContain('https://example.com/session-probe');
  });

  it('camera, microphone, geolocation and notifications are denied', async () => {
    const r = await page.evaluate(async () => {
      // a request that never answers is not a grant either (macOS can hold an audio capture probe)
      const race = (p: Promise<string>) =>
        Promise.race([p, new Promise<string>((res) => setTimeout(() => res('no answer'), 5000))]);
      const gum = (c: MediaStreamConstraints) =>
        race(
          navigator.mediaDevices.getUserMedia(c).then(
            () => 'granted',
            (e: Error) => `denied:${e.name}`,
          ),
        );
      const camera = await gum({ video: true });
      const microphone = await gum({ audio: true });
      const notifications = await race(Notification.requestPermission());
      const geolocation = await race(
        new Promise<string>((res) =>
          navigator.geolocation.getCurrentPosition(
            () => res('granted'),
            (e) => res(`denied:${e.code}`),
          ),
        ),
      );
      return { camera, microphone, notifications, geolocation };
    });
    expect(r.camera).toBe('denied:NotAllowedError');
    expect(r.microphone).not.toBe('granted');
    expect(r.notifications).toBe('denied');
    expect(r.geolocation).toBe('denied:1');
    const log = await app.evaluate(() => (globalThis as unknown as { __voxTest: Hooks }).__voxTest.log);
    expect(log.permissions).toEqual(expect.arrayContaining(['media', 'notifications', 'geolocation']));
  });
});

describe('IPC (S11)', () => {
  it('a valid call from the app frame works; bad args get a zod error', async () => {
    const list = await page.evaluate(() => window.vox.projects.list());
    expect(list).toEqual([expect.objectContaining({ id: projectId })]);
    const bad = await page.evaluate(() =>
      window.vox.projects.open(42 as unknown as string).then(
        () => 'resolved',
        (e: { code: string }) => e.code,
      ),
    );
    expect(bad).toBe('ARGS_INVALID');
  });

  it('calls from a subframe or from a non-vox-app window are rejected', async () => {
    await page.evaluate((id) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.src = `vox-media://p/${id}/build/seq_hostile/data.json`;
      f.id = 'probe';
      document.body.append(f);
    }, projectId);
    await page.waitForTimeout(500);
    const r = await app.evaluate(async ({ BrowserWindow }) => {
      const t = (globalThis as unknown as { __voxTest: Hooks }).__voxTest;
      const win = BrowserWindow.getAllWindows()[0]!;
      const main = await t.callAs(win.webContents.mainFrame, 'projects.list', []);
      const sub = win.webContents.mainFrame.frames[0];
      const fromSub = sub ? await t.callAs(sub, 'projects.list', []) : { ok: true, error: { code: 'no subframe' } };
      const other = new BrowserWindow({ show: false });
      await other.loadURL('data:text/html,<p>other</p>');
      const fromOther = await t.callAs(other.webContents.mainFrame, 'projects.list', []);
      other.destroy();
      return { main: main.ok, fromSub, fromOther };
    });
    expect(r.main).toBe(true);
    expect(r.fromSub).toMatchObject({ ok: false, error: { code: 'IPC_REJECTED' } });
    expect(r.fromOther).toMatchObject({ ok: false, error: { code: 'IPC_REJECTED' } });
    await page.evaluate(() => document.getElementById('probe')?.remove());
  });
});

describe('vox-media:// (S1, S13)', () => {
  const base = () => `vox-media://p/${projectId}/build/seq_hostile`;

  it('HTML carries the media CSP with connect-src none and frame-ancestors vox-app:', async () => {
    const r = await mediaFetch(`${base()}/index.html`);
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(r.headers['content-security-policy']).toContain('frame-ancestors vox-app:');
  });

  it('non-media types are attachments with nosniff; ranges return 206', async () => {
    const j = await mediaFetch(`${base()}/data.json`);
    expect(j.headers['content-disposition']).toBe('attachment');
    expect(j.headers['x-content-type-options']).toBe('nosniff');
    const v = await mediaFetch(`${base()}/clip.mp4`, { Range: 'bytes=100-199' });
    expect(v.status).toBe(206);
    expect(v.headers['content-range']).toBe('bytes 100-199/4096');
    expect(v.size).toBe(100);
  });

  it.each([
    ['encoded ..', '/build/%2e%2e/%2e%2e/%2e%2e/etc/passwd'],
    ['encoded slashes', '/build%2f..%2f..%2fproject.json'],
    ['double encoding', '/%252e%252e/project.json'],
    ['NUL', '/project.json%00.html'],
    ['absolute', '//etc/passwd'],
  ])('traversal is rejected: %s', async (_l, rel) => {
    const r = await mediaFetch(`vox-media://p/${projectId}${rel}`);
    expect(r.status).toBe(404);
  });
});

describe('hostile template (S14)', () => {
  it('fetch, parent.vox and window.top.location all get nothing', async () => {
    const result = await page.evaluate(
      (id) =>
        new Promise<Record<string, string>>((resolve) => {
          window.addEventListener('message', (e) => {
            const d = e.data as { hostile?: Record<string, string> };
            if (d?.hostile) resolve(d.hostile);
          });
          const f = document.createElement('iframe');
          f.setAttribute('sandbox', 'allow-scripts'); // what <hyperframes-player sandbox-origin="opaque"> sets
          f.src = `vox-media://p/${id}/build/seq_hostile/index.html`;
          document.body.append(f);
        }),
      projectId,
    );
    expect(result).toMatchObject({
      parentVox: 'blocked',
      topVox: 'blocked',
      topLocation: 'blocked',
      fetch: 'blocked',
    });
    await page.waitForTimeout(300);
    expect(page.url()).toBe('vox-app://app/index.html');
    const log = await app.evaluate(() => (globalThis as unknown as { __voxTest: Hooks }).__voxTest.log);
    expect(log.external).not.toContain('https://example.com/');
  });

  it('no console errors from the app page itself', () => {
    const own = consoleErrors.filter((m) => !/example|evil|127\.0\.0\.1|ERR_BLOCKED|Refused|denied|Permission|geolocation|net::|Unsafe attempt to initiate navigation/i.test(m));
    expect(own, consoleErrors.join(" | ")).toEqual([]);
  });
});
