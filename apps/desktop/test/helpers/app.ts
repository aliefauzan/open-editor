// Launches the built app (out/) with Playwright's Electron driver against temp folders.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';

export const DESKTOP = join(import.meta.dirname, '..', '..');
export const REPO = join(DESKTOP, '..', '..');
export const STYLES = join(REPO, 'styles');

/** Builds out/ once when it is missing (`test:slow` and `e2e` build first anyway). */
export function ensureBuilt(): void {
  if (!existsSync(join(DESKTOP, 'out', 'main', 'index.cjs'))) {
    execFileSync(process.execPath, [join(DESKTOP, 'scripts', 'build.ts')], { stdio: 'inherit' });
  }
}

export interface TempHome {
  home: string;
  projectsDir: string;
}

export function tempHome(prefix = 'vox-app-'): TempHome {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return { home, projectsDir: join(home, 'Projects') };
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  consoleErrors: string[];
}

export async function launchApp(t: TempHome): Promise<Launched> {
  ensureBuilt();
  const app = await _electron.launch({
    args: [DESKTOP],
    cwd: DESKTOP,
    env: {
      ...process.env,
      VOX_E2E: '1',
      VOX_HOME: join(t.home, '.vox'),
      VOX_PROJECTS_DIR: t.projectsDir,
      VOX_TOOLS_DIR: join(t.home, 'tools'),
    },
  });
  const page = await app.firstWindow();
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(async () => {
    const t = (globalThis as unknown as { __voxTest: { roots(): unknown } }).__voxTest;
    for (let i = 0; i < 200 && !t.roots(); i++) await new Promise((r) => setTimeout(r, 50));
  });
  return { app, page, consoleErrors };
}
