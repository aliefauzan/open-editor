// The engine host's setup service (plan phase 09 steps 1–3): status → install all with progress →
// ffmpeg via (fake) Homebrew → doctor → "Ready"; the engine's tool map follows; S16 hash refusal
// through the IPC error shape; launch-time re-sync of a stale Python env (D-12); the update check.
import { existsSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DoctorReport } from '@vox/engine';
import { AppSetup, type AppSetupOptions } from '../../src/engine-host/app-setup.ts';
import { fixture } from './fixture.ts';
import { serve } from './helpers.ts';

const OK: DoctorReport = { ok: true, checks: [{ name: 'ffmpeg', level: 'ok', detail: 'ok' }] };

async function service(
  f: Awaited<ReturnType<typeof fixture>>,
  extra: Partial<AppSetupOptions> = {},
) {
  const tools: Record<string, string | undefined> = {};
  const doctorCalls: unknown[] = [];
  const setup = new AppSetup({
    toolsDir: f.toolsDir,
    pyDir: f.ctx.pyDir!,
    env: f.ctx.env!,
    tools,
    emit: (e) => f.events.push(e),
    doctor: async (o) => {
      doctorCalls.push(o);
      return OK;
    },
    delegates: f.ctx.delegates!,
    manifest: f.ctx.manifest!,
    allowLoopbackHttp: true,
    packaged: false,
    currentVersion: '0.1.0',
    ...extra,
  });
  return { setup, tools, doctorCalls };
}

describe('AppSetup', () => {
  test('fresh tools folder → install all → brew install ffmpeg → doctor → Ready', async () => {
    const f = await fixture();
    const { setup, tools, doctorCalls } = await service(f);
    const first = await setup.status();
    expect(first.done).toBe(false);
    expect(first.ffmpeg.state).toBe('ffmpeg-missing');
    expect(first.ffmpeg.commands).toEqual(['brew install ffmpeg']);
    expect(first.disabledStages['render']).toContain('ffmpeg');
    expect(doctorCalls).toHaveLength(0);
    expect(tools['ffmpeg']).toBeUndefined();

    const r = await setup.install('all');
    expect(r.failed).toEqual([]);
    expect(r.installed.sort()).toEqual(['chrome', 'deno', 'python-env', 'uv', 'yt-dlp']);
    expect(f.events.some((e) => e.component === 'deno' && e.phase === 'done')).toBe(true);
    expect(tools['deno']).toBe(join(f.toolsDir, 'deno', '2.9.5', 'deno'));
    expect(readlinkSync(join(f.toolsDir, 'bin', 'deno'))).toBe(join('..', 'deno', '2.9.5', 'deno'));
    expect(tools['pyEnv']).toBe(join(f.toolsDir, 'py-env'));

    const waiting = await setup.status();
    expect(waiting.done).toBe(false); // ffmpeg still missing: no doctor yet
    expect(Object.keys(waiting.disabledStages).sort()).toEqual(
      Object.keys(first.disabledStages)
        .filter((s) => first.disabledStages[s]!.includes('ffmpeg'))
        .sort(),
    );

    f.installFfmpeg(); // the user ran the copied command; "Check again"
    const ready = await setup.status({ waitForDoctor: true });
    expect(ready.ready).toBe(true);
    expect(ready.doctor).toEqual(OK);
    expect(ready.done).toBe(true);
    expect(ready.disabledStages).toEqual({});
    expect(tools['ffmpeg']).toMatch(/brew-opt\/ffmpeg\/bin\/ffmpeg$/);
  });

  test('a doctor error keeps setup from "Ready"', async () => {
    const f = await fixture();
    const { setup } = await service(f, {
      doctor: async () => ({
        ok: false,
        checks: [{ name: 'python-env', level: 'error', detail: 'x', fix: 'repair' }],
      }),
    });
    await setup.install('all');
    f.installFfmpeg();
    const pending = await setup.status();
    expect(pending.doctorRunning).toBe(true);
    const s = await setup.status({ waitForDoctor: true });
    expect(f.events).toContainEqual({ type: 'setup.progress', component: 'doctor', phase: 'done' });
    expect(s.ready).toBe(true);
    expect(s.done).toBe(false);
    expect(s.doctor?.checks[0]?.fix).toBe('repair');
  });

  test('S16: a hash mismatch is refused with an IPC error; the tool stays missing', async () => {
    const f = await fixture({ badDenoHash: true });
    const { setup, tools } = await service(f);
    await expect(setup.install('deno')).rejects.toMatchObject({
      code: 'SETUP_HASH_MISMATCH',
      hint: expect.stringMatching(/repair/),
    });
    expect((await setup.status()).components.find((c) => c.id === 'deno')?.state).toBe('missing');
    expect(tools['deno']).toBeUndefined();
    expect(existsSync(join(f.toolsDir, 'bin', 'deno'))).toBe(false);
    await expect(setup.install('nope')).rejects.toMatchObject({ code: 'SETUP_NOT_INSTALLABLE' });
  });

  test('launch re-syncs a Python env built from an older uv.lock once (D-12)', async () => {
    const f = await fixture();
    const { setup } = await service(f);
    await setup.install('all');
    expect(f.syncCalls()).toBe(1);
    await setup.onLaunch();
    expect(f.syncCalls()).toBe(1); // unchanged lock: no sync
    writeFileSync(join(f.ctx.pyDir!, 'uv.lock'), 'lock v2\n'); // app update ships a new lock
    await setup.onLaunch();
    expect(f.syncCalls()).toBe(2);
    await setup.onLaunch();
    expect(f.syncCalls()).toBe(2);
  });

  test('packaged: the engine always gets <tools>/py-env, never the bundle', async () => {
    const f = await fixture();
    const { setup, tools } = await service(f, { packaged: true });
    await setup.status();
    expect(tools['pyEnv']).toBe(join(f.toolsDir, 'py-env'));
    expect(tools['py']).toBe(f.ctx.pyDir);
  });

  test('update check on launch: a newer release shows; no repo turns it off', async () => {
    const f = await fixture();
    const api = await serve({
      '/repos/owner/app/releases/latest': JSON.stringify({
        tag_name: 'v0.2.0',
        name: 'Vox Studio 0.2.0',
        html_url: 'https://github.com/owner/app/releases/tag/v0.2.0',
        draft: false,
        prerelease: false,
        published_at: '2026-10-01T00:00:00Z',
      }),
    });
    const on = await service(f, { updateRepo: 'owner/app', updateApiBase: api.base });
    expect((await on.setup.status()).update).toEqual({ status: 'pending' });
    await on.setup.onLaunch();
    expect((await on.setup.status()).update).toMatchObject({
      status: 'available',
      latest: '0.2.0',
      url: 'https://github.com/owner/app/releases/tag/v0.2.0',
    });
    const off = await service(f, { updateRepo: '' });
    await off.setup.onLaunch();
    expect((await off.setup.status()).update).toEqual({ status: 'disabled' });
  });
});
