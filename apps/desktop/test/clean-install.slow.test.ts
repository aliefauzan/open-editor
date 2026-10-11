// Plan phase 09 step 9 (D-16, replaces a second-account run): the built `.dmg` with a quarantine
// attribute is mounted, the app copied to a temp folder and `spctl` recorded (expected: rejected,
// ad-hoc signed, hence the README's "Open Anyway"); the app then runs with temp VOX_HOME /
// VOX_TOOLS_DIR / HOME and a PATH without Homebrew: the setup screen shows the ffmpeg-missing view
// with its copy commands. With fixture components and a fake `brew` on PATH, setup reaches "Ready".
// Then the full editor (phase 10b, GATE 5 render part of the packaging smoke test, D-12): the offline
// fixture project opens in the editor and the app renders it to MP4, SRT and OTIO.
// Evidence: docs/evidence/phase-09/ (spctl output, screenshots), or VOX_EVIDENCE_DIR.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { openEngine } from '@vox/engine';
import { makeOfflineProject } from '../../../scripts/make-offline-project.ts';
import { STYLES } from './helpers/app.ts';
import { EVIDENCE, builtDmg, fakeBrew, launchPackaged, seedTools } from './helpers/packaged.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'vox-clean-')));
const mnt = join(root, 'mnt');
const app = join(root, 'Applications', 'Vox Studio.app');
const home = join(root, 'home');
const toolsDir = join(home, 'tools');
const log: string[] = [];
/** Recorded output without the temp folder's path. */
const rec = (title: string, text: string) =>
  log.push(`$ ${title}\n${text.replaceAll(root, '<tmp>').trim()}\n`);

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  rec(
    `${cmd.split('/').pop()!} ${args.map((a) => a.replaceAll(root, '<tmp>')).join(' ')}  (exit ${String(r.status)})`,
    out,
  );
  return out;
}

const baseEnv = (path: string): NodeJS.ProcessEnv => ({
  HOME: home,
  PATH: path,
  VOX_HOME: join(home, '.vox'),
  VOX_PROJECTS_DIR: join(home, 'Projects'),
  VOX_TOOLS_DIR: toolsDir,
  VOX_NO_BREW_FALLBACK: '1',
  VOX_UPDATE_REPO: '',
});
const NO_BREW_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

afterAll(() => {
  spawnSync('/usr/bin/hdiutil', ['detach', mnt, '-force'], { encoding: 'utf8' });
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'clean-install.txt'), log.join('\n'));
});

describe('clean install from the quarantined .dmg (D-16)', () => {
  test('quarantine, mount, copy, spctl recorded', () => {
    const dmg = join(root, 'Vox-Studio.dmg');
    copyFileSync(builtDmg(), dmg);
    const stamp = Math.floor(Date.now() / 1000).toString(16);
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${stamp};Safari;`, dmg]);
    run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', dmg]);
    mkdirSync(mnt, { recursive: true });
    execFileSync(
      '/usr/bin/hdiutil',
      ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dmg],
      {
        stdio: 'ignore',
      },
    );
    mkdirSync(join(root, 'Applications'), { recursive: true });
    execFileSync('/usr/bin/ditto', [join(mnt, 'Vox Studio.app'), app]);
    run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app]);
    const spctl = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app]);
    expect(spctl).toMatch(/rejected/); // ad-hoc signed, not notarized: Gatekeeper asks for "Open Anyway"
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-vv', app]);
    // the README's alternative to "Open Anyway" (plan 9b keeps the dialog itself a MANUAL STEP)
    run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]);
  });

  test('no Homebrew on PATH: the setup screen shows the ffmpeg-missing view', async () => {
    mkdirSync(toolsDir, { recursive: true });
    const a = await launchPackaged(app, { env: baseEnv(NO_BREW_PATH), userData: join(home, 'ud') });
    try {
      const view = a.page.getByTestId('ffmpeg-missing');
      await view.waitFor({ timeout: 120_000 });
      expect(await view.getAttribute('data-state')).toBe('brew-missing');
      const text = await view.innerText();
      expect(text).toContain('brew install ffmpeg');
      expect(text).toContain('Homebrew/install');
      expect(await a.page.getByTestId('check-again').isVisible()).toBe(true);
      expect(await a.page.getByTestId('setup-ready').count()).toBe(0);
      await a.page.screenshot({ path: join(EVIDENCE, 'setup-ffmpeg-missing.png') });
    } finally {
      await a.close();
    }
  });

  test('fixture components + fake brew: setup reaches "Ready"', async () => {
    await seedTools({ toolsDir, home, pyDir: join(app, 'Contents', 'Resources', 'py') });
    const brew = fakeBrew(join(root, 'brew'));
    const a = await launchPackaged(app, {
      env: baseEnv(`${brew}:${NO_BREW_PATH}`),
      userData: join(home, 'ud'),
    });
    try {
      // setup finished: the app opens in the editor with nothing waiting; the Setup screen says Ready
      await a.page.getByTestId('open-setup').click({ timeout: 120_000 });
      const ready = a.page.getByTestId('setup-ready');
      await ready.waitFor({ timeout: 420_000 }).catch(async (e: unknown) => {
        await a.page.screenshot({ path: join(EVIDENCE, 'setup-not-ready.png') });
        const probe = await a.page.evaluate(() =>
          Promise.race([
            window.vox.setup.status().then(
              (x) => JSON.stringify(x).slice(0, 2000),
              (x: unknown) => `error ${JSON.stringify(x)}`,
            ),
            new Promise<string>((r) => setTimeout(() => r('status: no answer in 60 s'), 60_000)),
          ]),
        );
        // what the doctor is still waiting on (child processes under the temp folder)
        const procs = spawnSync('/usr/bin/pgrep', ['-fl', root], { encoding: 'utf8' }).stdout;
        rec('setup not ready', `${probe}\n${procs}\n${a.stderr().slice(-3000)}`);
        throw e;
      });
      for (const id of ['uv', 'deno', 'yt-dlp', 'python-env', 'chrome', 'ffmpeg'])
        expect(await a.page.getByTestId(`component-${id}`).getAttribute('data-state')).toBe(
          'ready',
        );
      await a.page.screenshot({ path: join(EVIDENCE, 'setup-ready.png') });
      rec('setup screen', 'Ready (components ready, doctor without errors)');
    } finally {
      await a.close();
    }
  }, 900_000);

  test('the full editor: the offline fixture opens and renders to MP4, SRT and OTIO (10b)', async () => {
    const e = openEngine({ projectsDir: join(home, 'Projects'), stylesDirs: [STYLES] });
    const off = await makeOfflineProject(e, 'Clean install fixture');
    const brew = fakeBrew(join(root, 'brew'));
    const a = await launchPackaged(app, {
      env: baseEnv(`${brew}:${NO_BREW_PATH}`),
      userData: join(home, 'ud'),
    });
    try {
      await a.page
        .getByRole('button', { name: 'Clean install fixture' })
        .click({ timeout: 120_000 });
      await a.page.getByTestId('player').waitFor({ timeout: 120_000 });
      await a.page.screenshot({ path: join(EVIDENCE, 'clean-install-editor.png') });
      const r = await a.page.evaluate(
        async ({ pid, seq }) => {
          const wait = async (id: string) => {
            for (;;) {
              const j = (await window.vox.jobs.get(id)) as {
                status: string;
                result?: { files?: { path: string; durationMs: number }[]; path?: string };
                error?: unknown;
              };
              if (j.status !== 'queued' && j.status !== 'running') return j;
              await new Promise((x) => setTimeout(x, 500));
            }
          };
          const start = (kind: string, args: Record<string, unknown>) =>
            window.vox.jobs.start(kind, {
              projectId: pid,
              sequenceId: seq,
              ...args,
            }) as Promise<string>;
          const mp4 = await wait(await start('render', { quality: 'draft' }));
          const srt = await wait(await start('exportCaptions', { format: 'srt' }));
          const otio = await wait(await start('exportTimeline', {}));
          return { mp4, srt, otio };
        },
        { pid: off.projectId, seq: off.sequenceId },
      );
      rec('render from the installed app', JSON.stringify(r, null, 2).replaceAll(home, '<home>'));
      expect(r.mp4.status, JSON.stringify(r.mp4.error)).toBe('done');
      expect(r.srt.status).toBe('done');
      expect(r.otio.status).toBe('done');
      const file = r.mp4.result!.files![0]!;
      expect(Math.abs(file.durationMs - 20_000)).toBeLessThan(200);
    } finally {
      await a.close();
    }
  }, 900_000);
});
