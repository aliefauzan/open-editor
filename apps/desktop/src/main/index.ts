// Electron main: the window and its security flags, the two schemes, IPC routing to the engine
// host (app spec "Architecture", "Window security", "Untrusted HTML"; R4 S1, S10–S15, S28).
import { join } from 'node:path';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import { projectDirFor } from '@vox/engine/paths';
import { type EventName, type Method } from '../shared/api.ts';
import { handleCall, isAllowedExternal, type FrameLike } from './guard.ts';
import { EngineHost } from './host.ts';
import { installCli } from './install-cli.ts';
import {
  CSP_APP,
  CSP_MEDIA,
  fileResponse,
  notFound,
  resolveAppPath,
  resolveMediaPath,
} from './protocol.ts';

protocol.registerSchemesAsPrivileged([
  { scheme: 'vox-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'vox-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      // CORS mode on (fonts in the opaque sandbox need it); only font responses carry
      // Access-Control-Allow-Origin, so other cross-origin reads stay blocked (D-37)
      corsEnabled: true,
    },
  },
]);

/** Test hooks only for unpackaged builds started with VOX_E2E=1; release builds never have them. */
const TEST = !app.isPackaged && process.env['VOX_E2E'] === '1';
const APP_ROOT = app.getAppPath();
const RENDERER_DIR = join(APP_ROOT, 'out', 'renderer');
const PRELOAD = join(APP_ROOT, 'out', 'preload', 'index.cjs');
const HOST_ENTRY = app.isPackaged
  ? join(APP_ROOT, 'out', 'engine-host', 'index.mjs')
  : join(APP_ROOT, 'src', 'engine-host', 'index.ts');
const BUILTIN_STYLES = app.isPackaged
  ? join(process.resourcesPath, 'styles')
  : join(APP_ROOT, '..', '..', 'styles');

export const WEB_PREFERENCES = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
  spellcheck: false,
} as const;

const appWindows = new Set<WebContents>();
const testLog = { blocked: [] as string[], external: [] as string[], permissions: [] as string[] };

const log = (line: string) => {
  if (TEST || !app.isPackaged) process.stderr.write(`${line}\n`);
};

function broadcast(name: EventName, payload: unknown): void {
  for (const wc of appWindows) if (!wc.isDestroyed()) wc.send('vox:event', name, payload);
}

const host = new EngineHost({
  entry: HOST_ENTRY,
  init: {
    builtinStyles: BUILTIN_STYLES,
    appVersion: app.getVersion(),
    ...(app.isPackaged ? { resources: process.resourcesPath } : {}),
  },
  onEvent: broadcast,
  onRestart: (info) => broadcast('host.restarted', info),
  log,
});

function openExternal(url: string): void {
  if (!isAllowedExternal(url)) return;
  if (TEST) testLog.external.push(url);
  else void shell.openExternal(url);
}

/** Main-only methods (dialogs, Finder); everything else goes to the engine host. */
async function forward(method: Method, args: unknown[]): Promise<unknown> {
  if (method === 'projects.reveal') {
    const roots = host.roots;
    if (!roots) throw new Error('The engine is not ready');
    shell.showItemInFolder(projectDirFor(roots.projectsDir, args[0] as string));
    return null;
  }
  return host.call(method, args);
}

function call(frame: WebFrameMain | null, sender: WebContents, method: unknown, args: unknown) {
  return handleCall(frame as FrameLike | null, appWindows.has(sender), method, args, forward);
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.protocol.handle('vox-app', async (req) => {
    const file = await resolveAppPath(req.url, RENDERER_DIR);
    return file ? fileResponse(file, req, CSP_APP) : notFound();
  });
  ses.protocol.handle('vox-media', async (req) => {
    const roots = host.roots;
    const file = roots ? await resolveMediaPath(req.url, roots) : null;
    return file ? fileResponse(file, req, CSP_MEDIA) : notFound();
  });
  // S12: renderers have no http(s)/ws(s); the engine host does all network work.
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (d, cb) => {
      if (TEST) testLog.blocked.push(d.url);
      cb({ cancel: true });
    },
  );
  // S15: no camera, microphone, geolocation, notifications, …
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    if (TEST) testLog.permissions.push(permission);
    cb(false);
  });
  ses.setPermissionCheckHandler(() => false);
}

app.on('web-contents-created', (_e, wc) => {
  // S10: no navigation, no new windows, no webviews; allowlisted links open in the browser.
  wc.on('will-navigate', (e, url) => {
    e.preventDefault();
    openExternal(url);
  });
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#111111',
    title: 'Vox Studio',
    webPreferences: { ...WEB_PREFERENCES },
  });
  const wc = win.webContents;
  appWindows.add(wc);
  wc.once('destroyed', () => appWindows.delete(wc));
  void win.loadURL('vox-app://app/index.html');
  return win;
}

ipcMain.handle('vox:call', (e, method: unknown, args: unknown) =>
  call(e.senderFrame, e.sender, method, args),
);

if (TEST) {
  Object.assign(globalThis, {
    __voxTest: {
      log: testLog,
      hostPid: () => host.pid,
      restarts: () => host.restarts,
      roots: () => host.roots,
      // the effective preferences Chromium got (not in Electron 44's typings, present at runtime)
      webPreferences: () =>
        BrowserWindow.getAllWindows().map((w) =>
          (
            w.webContents as unknown as { getLastWebPreferences(): unknown }
          ).getLastWebPreferences(),
        ),
      /** Runs the real IPC check for a given frame (a subframe, another window, …). */
      callAs: (frame: WebFrameMain, method: string, args: unknown[]) =>
        call(frame, webContentsOf(frame), method, args),
    },
  });
}

function webContentsOf(frame: WebFrameMain): WebContents {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.mainFrame.framesInSubtree.includes(frame)) return w.webContents;
  }
  throw new Error('frame has no window');
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => host.stop());

/** Menu "Install `vox` command" (packaged app only: the script lives in Resources/cli). */
async function installVoxCommand(): Promise<void> {
  const choice = await dialog.showMessageBox({
    type: 'question',
    message: 'Install the vox command',
    detail:
      'Links vox to the CLI inside this app. "For me" needs no password; "For all users" ' +
      'asks for an administrator password.',
    buttons: ['For me (~/.local/bin)', 'For all users (/usr/local/bin)', 'Cancel'],
    cancelId: 2,
  });
  if (choice.response === 2) return;
  try {
    const r = await installCli({
      resources: process.resourcesPath,
      target: choice.response === 0 ? 'user' : 'system',
      home: app.getPath('home'),
      path: process.env['PATH'] ?? '',
    });
    await dialog.showMessageBox({
      message: `Installed ${r.link}`,
      detail: r.onPath
        ? 'Open a new Terminal window and run: vox --help'
        : 'Add ~/.local/bin to your PATH (for zsh: echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zshrc), then open a new Terminal window.',
    });
  } catch (e) {
    dialog.showErrorBox('Could not install the vox command', String(e));
  }
}

function setMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Install vox Command…',
            enabled: app.isPackaged,
            click: () => void installVoxCommand(),
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

void app.whenReady().then(async () => {
  hardenSession();
  setMenu();
  createWindow();
  await host.start().catch((e: unknown) => log(`engine host failed to start: ${String(e)}`));
});
