// Live run (tag slow, needs network): installs the real pinned uv and deno and the real yt-dlp into a
// temp tools folder, checks they run, and records the yt-dlp impersonation support.
import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { installComponent } from '../../src/engine-host/setup/install.ts';
import { loadManifest } from '../../src/engine-host/setup/manifest.ts';
import { runCommand } from '../../src/engine-host/setup/run.ts';
import { checkImpersonation } from '../../src/engine-host/setup/ytdlp.ts';
import { noSignal, tmp } from './helpers.ts';

describe('live first-run downloads', () => {
  const manifest = loadManifest();
  const get = (id: string) => {
    const c = manifest.components.find((x) => x.id === id);
    if (c === undefined) throw new Error(`no ${id}`);
    return c;
  };

  test('uv and deno install from the pins and run', async () => {
    const toolsDir = tmp('live-tools');
    for (const id of ['uv', 'deno'] as const) {
      const r = await installComponent(get(id), { toolsDir, signal: noSignal() });
      const v = await runCommand(r.path, ['--version'], { signal: noSignal() });
      expect(v.code).toBe(0);
      expect(v.stdout).toContain(r.version);
      expect(r.path.startsWith(join(toolsDir, id))).toBe(true);
    }
  });

  test('yt-dlp installs against its published checksum list; impersonation is reported', async () => {
    const toolsDir = tmp('live-tools');
    const r = await installComponent(get('yt-dlp'), { toolsDir, signal: noSignal() });
    const v = await runCommand(r.path, ['--version'], { signal: noSignal() });
    expect(v.code).toBe(0);
    const imp = await checkImpersonation(r.path, { signal: noSignal() });
    console.log(`yt-dlp ${v.stdout.trim()} impersonation:`, JSON.stringify(imp));
    expect(typeof imp.supported).toBe('boolean');
  });
});
