// Menu "Install `vox` command" (app spec "Architecture"; plan phase 09): a symlink in
// `~/.local/bin` (no admin) or `/usr/local/bin` (admin prompt) to `<Resources>/cli/vox`, the script
// that runs the bundled CLI with the app's Electron as Node (`ELECTRON_RUN_AS_NODE=1`).
import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export type CliTarget = 'user' | 'system';

export interface InstallCliResult {
  link: string;
  target: string;
  /** `~/.local/bin` is not on PATH: the dialog says how to add it. */
  onPath: boolean;
}

export function cliScript(resources: string): string {
  return join(resources, 'cli', 'vox');
}

export function linkPath(target: CliTarget, home: string): string {
  return target === 'user' ? join(home, '.local', 'bin', 'vox') : '/usr/local/bin/vox';
}

/** Refuses to replace a regular file someone put there; an old link is replaced. */
async function assertReplaceable(link: string): Promise<void> {
  const st = await lstat(link).catch(() => undefined);
  if (st && !st.isSymbolicLink())
    throw new Error(`${link} exists and is not a link; remove it first`);
}

/** Single-quoted for /bin/sh. */
const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export async function installCli(o: {
  resources: string;
  target: CliTarget;
  home: string;
  path?: string;
  /** System target: runs the shell command with administrator privileges (osascript prompt). */
  runAsAdmin?: (shell: string) => Promise<void>;
}): Promise<InstallCliResult> {
  const target = cliScript(o.resources);
  const link = linkPath(o.target, o.home);
  await assertReplaceable(link);
  if (o.target === 'user') {
    const dir = join(o.home, '.local', 'bin');
    await mkdir(dir, { recursive: true });
    if ((await readlink(link).catch(() => undefined)) !== target) {
      const tmp = `${link}.${process.pid}.tmp`;
      await rm(tmp, { force: true });
      await symlink(target, tmp);
      await rename(tmp, link);
    }
    const onPath = (o.path ?? '').split(':').includes(dir);
    return { link, target, onPath };
  }
  const admin = o.runAsAdmin ?? runAsAdmin;
  await admin(`/bin/mkdir -p /usr/local/bin && /bin/ln -sfn ${sq(target)} ${sq(link)}`);
  return { link, target, onPath: true };
}

/** macOS administrator prompt through osascript (the user may cancel: that rejects). */
export async function runAsAdmin(shell: string): Promise<void> {
  const script = `do shell script ${JSON.stringify(shell)} with administrator privileges`;
  await promisify(execFile)('/usr/bin/osascript', ['-e', script]);
}
