// Shared steps of the 10b E2E specs (Playwright for Electron, the `VOX_E2E=1` test build): launch on a
// temp home, answer the next native dialog, drive window.vox from the page for checks, wait for
// export jobs, probe files with ffprobe/ffmpeg.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Frame, Page } from 'playwright';
import { expect } from '@playwright/test';
import { openEngine } from '@vox/engine';
import { makeOfflineProject, type OfflineProject } from '../../../scripts/make-offline-project.ts';
import { launchApp, REPO, STYLES, tempHome, type TempHome } from '../test/helpers/app.ts';

export const SEEDS = join(REPO, 'packages', 'engine', 'test', 'fixtures', 'assets', 'media');
export const SEED = (ext: 'mp4' | 'mov' | 'webm') => join(SEEDS, `talking-head-20s.${ext}`);

const tool = (name: string) =>
  ['/opt/homebrew/bin', '/usr/local/bin'].map((d) => join(d, name)).find(existsSync) ?? name;

export interface Session {
  app: ElectronApplication;
  page: Page;
  errors: string[];
  home: TempHome;
  offline?: OfflineProject;
}

export async function start(
  o: { offline?: string; env?: Record<string, string> } = {},
): Promise<Session> {
  const home = tempHome('vox-e2e-');
  let offline: OfflineProject | undefined;
  if (o.offline) {
    const e = openEngine({ projectsDir: home.projectsDir, stylesDirs: [STYLES] });
    offline = await makeOfflineProject(e, o.offline);
  }
  const { app, page, consoleErrors } = await launchApp(home, o.env ? { env: o.env } : {});
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  return { app, page, errors: consoleErrors, home, ...(offline ? { offline } : {}) };
}

/** The next native dialog's answer (test build only): a folder, files, or null (cancel). */
export async function answerDialog(s: Session, answer: string | string[] | null): Promise<void> {
  await s.app.evaluate((_e, a) => {
    (
      globalThis as unknown as { __voxTest: { answerDialog(x: unknown): void } }
    ).__voxTest.answerDialog(a);
  }, answer);
}

/** Calls window.vox from the page (checks only; the UI does the edits). */
export function vox<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([f, a]) => {
      const [area, name] = (f as string).split('.') as [string, string];
      const api = (
        window as unknown as { vox: Record<string, Record<string, (...x: unknown[]) => unknown>> }
      ).vox;
      return (await api[area]![name]!(...(a as unknown[]))) as unknown;
    },
    [fn, args] as const,
  ) as Promise<T>;
}

export async function openProject(s: Session, name: string): Promise<void> {
  await s.page.getByRole('button', { name, exact: true }).click();
  await s.page.getByTestId('editor').waitFor();
  await s.page.getByTestId('player').waitFor({ timeout: 120_000 });
}

/** The player's iframe (opaque origin: reachable from Playwright, not from the app). */
export async function playerFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 300; i++) {
    const f = page.frames().find((x) => x.url().startsWith('vox-media://'));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  throw new Error('no player frame');
}

export async function previewHasText(page: Page, text: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const f = await playerFrame(page);
        return f
          .evaluate((t) => (document.body.textContent ?? '').includes(t), text)
          .catch(() => false);
      },
      { timeout },
    )
    .toBe(true);
}

/** Project id and version from the editor (through window.vox). */
export async function projectState(page: Page, id: string) {
  return vox<{ project: Record<string, unknown> & { sequences: SeqLike[] }; version: number }>(
    page,
    'projects.open',
    id,
  );
}
export interface SeqLike {
  id: string;
  name: string;
  videoTracks: { id: string; items: ItemLike[] }[];
  audioTracks: { id: string; items: ItemLike[] }[];
  captions: { overrides: { wordKey: string }[] } | null;
}
export interface ItemLike {
  id: string;
  type: string;
  startMs: number;
  durationMs: number;
  mediaId?: string;
  volume?: number;
  frame?: { mode: string; keyframes?: { atMs: number; x: number; y: number; scale: number }[] };
}
export const seqEnd = (s: SeqLike) =>
  Math.max(0, ...s.videoTracks.flatMap((t) => t.items.map((i) => i.startMs + i.durationMs)));

export const tempDir = (p: string) => mkdtempSync(join(tmpdir(), p));

export function durationMs(file: string): number {
  const out = execFileSync(tool('ffprobe'), [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]).toString();
  return Math.round(Number(out.trim()) * 1000);
}

/** One small grey frame of a video at `ms` (raw bytes), to compare two renders. */
export function frameAt(file: string, ms: number): Buffer {
  return execFileSync(tool('ffmpeg'), [
    '-v',
    'error',
    '-ss',
    (ms / 1000).toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'scale=108:192',
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    '-',
  ]);
}

/** Mean absolute difference of two grey frames (0–255). */
export function frameDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return n ? sum / n : 255;
}

/** Opens the export dialog, picks files and target folder, exports, waits for every written path. */
export async function exportTo(
  s: Session,
  folder: string,
  o: {
    formats: ('mp4' | 'srt' | 'vtt' | 'otio')[];
    loudness?: string;
    quality?: string;
    all?: boolean;
  },
): Promise<{ audioCheck: string }> {
  const { page } = s;
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Export' });
  await dlg.waitFor();
  const labels = {
    mp4: 'MP4 video',
    srt: 'SRT captions',
    vtt: 'VTT captions',
    otio: 'Editable timeline (OTIO)',
  } as const;
  for (const [f, label] of Object.entries(labels)) {
    const box = dlg.getByLabel(label);
    if ((await box.isChecked()) !== o.formats.includes(f as never)) await box.click();
  }
  if (o.all) await dlg.getByLabel(/^All sequences/).check();
  if (o.formats.includes('mp4')) {
    await dlg.getByLabel('Quality').selectOption(o.quality ?? 'draft');
    if (o.loudness) await dlg.getByLabel('Loudness target').selectOption(o.loudness);
  }
  await answerDialog(s, folder);
  await dlg.getByRole('button', { name: 'Change…' }).click();
  await expect(dlg.getByTestId('save-to')).toContainText(folder.split('/').pop()!);
  await dlg.getByRole('button', { name: /^Export \d+ files?$/ }).click();
  const progress = dlg.getByRole('list', { name: 'Export progress' });
  await progress.waitFor({ timeout: 600_000 });
  await expect
    .poll(async () => (await progress.textContent()) ?? '', { timeout: 900_000 })
    .not.toMatch(/\d+ %/);
  const text = (await progress.textContent()) ?? '';
  expect(text).not.toContain('failed');
  const audio = o.formats.includes('mp4')
    ? ((await dlg.getByRole('region', { name: 'Audio check' }).textContent()) ?? '')
    : '';
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();
  return { audioCheck: audio };
}

/** Pixels whose grey value differs by more than `threshold` (encoder noise stays below it). */
export function changedPixels(a: Buffer, b: Buffer, threshold = 40): number {
  const n = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i]! - b[i]!) > threshold) count++;
  return count;
}
