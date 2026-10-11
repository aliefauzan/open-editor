// GATE 4 step A3: the bench prototype inside the pinned Electron (the app shell's renderer).
// Bench-only main process: one 1920x1080 window (the U1 viewport, larger than the laptop screen),
// loading the URL in argv.
// Launched by timeline-runner.ts through Playwright's `_electron` (CommonJS: Playwright's Electron
// launcher waits for a CommonJS main); not part of the app.
'use strict';
const { BrowserWindow, app } = require('electron');

const url = process.argv.find((a) => a.startsWith('http://127.0.0.1:'));
if (!url) throw new Error('timeline-electron-main: no bench URL in argv');

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await win.loadURL(url);
});
