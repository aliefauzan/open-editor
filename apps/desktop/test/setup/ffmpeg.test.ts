// D-05: ffmpeg comes from Homebrew only. Setup detects it (fake brew on PATH) and never downloads it.
import { describe, expect, test } from 'vitest';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FFMPEG_INSTALL_COMMAND,
  HOMEBREW_INSTALL_COMMAND,
  detectFfmpeg,
} from '../../src/engine-host/setup/ffmpeg.ts';
import { loadManifest } from '../../src/engine-host/setup/manifest.ts';
import { noSignal, tmp, writeScript } from './helpers.ts';

function fakeBrewDir() {
  const root = tmp();
  const bin = join(root, 'bin');
  const prefix = join(root, 'opt', 'ffmpeg');
  mkdirSync(bin, { recursive: true });
  writeScript(
    join(bin, 'brew'),
    `[ "$1" = "--prefix" ] && [ "$2" = "ffmpeg" ] && { echo '${prefix}'; exit 0; }\nexit 1`,
  );
  return { root, bin, prefix };
}

function installFakeFfmpeg(prefix: string) {
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeScript(join(prefix, 'bin', 'ffmpeg'), 'echo "ffmpeg version 8.1.2 Copyright (c) 2000-2026"');
  writeScript(
    join(prefix, 'bin', 'ffprobe'),
    'echo "ffprobe version 8.1.2 Copyright (c) 2007-2026"',
  );
}

const env = (path: string) => ({ PATH: path, VOX_NO_BREW_FALLBACK: '1' });

describe('detectFfmpeg', () => {
  test('no brew on PATH: brew-missing, both commands, nothing downloaded', async () => {
    const empty = tmp();
    const r = await detectFfmpeg({ env: env(empty), signal: noSignal() });
    expect(r.state).toBe('brew-missing');
    expect(r.commands).toEqual([HOMEBREW_INSTALL_COMMAND, FFMPEG_INSTALL_COMMAND]);
    expect(FFMPEG_INSTALL_COMMAND).toBe('brew install ffmpeg');
    expect(HOMEBREW_INSTALL_COMMAND).toContain('raw.githubusercontent.com/Homebrew/install');
  });

  test('brew present but ffmpeg not installed: ffmpeg-missing with the one remaining command', async () => {
    const f = fakeBrewDir();
    const r = await detectFfmpeg({ env: env(f.bin), signal: noSignal() });
    expect(r.state).toBe('ffmpeg-missing');
    expect(r.commands).toEqual([FFMPEG_INSTALL_COMMAND]);
    expect(r.brewPath).toBe(join(f.bin, 'brew'));
  });

  test('"Check again" sees a later `brew install ffmpeg`', async () => {
    const f = fakeBrewDir();
    expect((await detectFfmpeg({ env: env(f.bin), signal: noSignal() })).state).toBe(
      'ffmpeg-missing',
    );
    installFakeFfmpeg(f.prefix);
    const r = await detectFfmpeg({ env: env(f.bin), signal: noSignal() });
    expect(r).toMatchObject({
      state: 'ok',
      ffmpegPath: join(f.prefix, 'bin', 'ffmpeg'),
      ffprobePath: join(f.prefix, 'bin', 'ffprobe'),
      version: '8.1.2',
      commands: [],
    });
  });

  test('ffprobe missing counts as ffmpeg-missing', async () => {
    const f = fakeBrewDir();
    installFakeFfmpeg(f.prefix);
    writeFileSync(join(f.prefix, 'bin', 'ffprobe'), 'not executable');
    chmodSync(join(f.prefix, 'bin', 'ffprobe'), 0o644);
    expect((await detectFfmpeg({ env: env(f.bin), signal: noSignal() })).state).toBe(
      'ffmpeg-missing',
    );
  });

  test('a Finder-launched app has a minimal PATH: fallback directories are searched unless disabled', async () => {
    const f = fakeBrewDir();
    installFakeFfmpeg(f.prefix);
    const minimal = tmp();
    const viaFallback = await detectFfmpeg({
      env: { PATH: minimal },
      fallbackDirs: [f.bin],
      signal: noSignal(),
    });
    expect(viaFallback.state).toBe('ok');
    const disabled = await detectFfmpeg({
      env: { PATH: minimal, VOX_NO_BREW_FALLBACK: '1' },
      fallbackDirs: [f.bin],
      signal: noSignal(),
    });
    expect(disabled.state).toBe('brew-missing');
  });
});

describe('no code path downloads ffmpeg (D-05)', () => {
  test('the manifest has no ffmpeg download', () => {
    const m = loadManifest();
    const ff = m.components.find((c) => c.id === 'ffmpeg');
    expect(ff).toBeDefined();
    expect(ff?.kind).toBe('external');
    expect(JSON.stringify(ff)).not.toMatch(/https?:/);
    for (const c of m.components) {
      if ('url' in c) expect(c.url).not.toMatch(/ffmpeg|ffprobe/i);
    }
  });

  test('no setup source mentions a place to fetch ffmpeg from', () => {
    const dir = new URL('../../src/engine-host/setup/', import.meta.url);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.json')) continue;
      const text = readFileSync(new URL(name, dir), 'utf8');
      expect(text, name).not.toMatch(
        /evermeet|johnvansickle|ffmpeg\.org\/releases|ffbinaries|btbn/i,
      );
    }
  });
});
