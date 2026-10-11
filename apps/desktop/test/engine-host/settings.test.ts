// Phase 13 step 1 + 1b: settings in the engine host (R4 S18, S33). Keys reach the renderer only
// masked, a masked or absent key in a save keeps the Keychain key, the key is never in config,
// results or project files (canary key from R4); a model that failed a role's probe cannot be
// assigned; the Apple row shows each `--status` value (fake helper); the cookies browser is written
// only through settings.save.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, presetIds } from '@vox/agent';
import { openEngine } from '@vox/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configDeps } from '../../../../packages/agent/test/helpers/fakes.ts';
import { CANARY_KEY } from '../../../../packages/agent/test/helpers/canary.ts';
import { scriptedModel } from '../../../../packages/agent/test/helpers/model.ts';
import { createHandlers } from '../../src/engine-host/handlers.ts';
import { parseRef, SettingsHost } from '../../src/engine-host/settings.ts';
import {
  METHOD_ARGS,
  parseCall,
  PRESET_IDS,
  type Method,
  type SettingsData,
} from '../../src/shared/api.ts';

const FAKE_APPLE = fileURLToPath(
  new URL('../../../../packages/agent/test/fixtures/fake-apple-llm.mjs', import.meta.url),
);
const STYLES = join(import.meta.dirname, '..', '..', '..', '..', 'styles');
const pass = () => Promise.resolve({ status: 'pass' as const });
const fail = (reason: string) => () => Promise.resolve({ status: 'fail' as const, reason });

type Checks = Record<'tools' | 'loop' | 'vision' | 'plan', () => Promise<{ status: string }>>;
const ALL_PASS: Checks = { tools: pass, loop: pass, vision: pass, plan: pass };

function setup(opts: { checks?: Checks; appleStatus?: string; appleHelper?: boolean } = {}) {
  const cfg = configDeps();
  const { model } = scriptedModel([]);
  const host = new SettingsHost({
    cfg,
    appleHelper: opts.appleHelper ?? true,
    apple: {
      command: process.execPath,
      args: [FAKE_APPLE],
      env: { VOX_FAKE_APPLE_STATUS: opts.appleStatus ?? 'ready' },
    },
    createModel: () => model,
    listLocalModels: () => Promise.resolve(['qwen3.5:latest']),
    probe: {
      checks: (opts.checks ?? ALL_PASS) as never,
      context: {
        openRouterModels: new Map([
          [
            'gw/model',
            {
              id: 'gw/model',
              contextLength: 128_000,
              price: { inPerMTok: 1, outPerMTok: 2 },
              inputModalities: ['text', 'image'],
              outputModalities: ['text'],
              supportsTools: true,
            },
          ],
        ]) as never,
      },
    },
  });
  const engine = openEngine({
    projectsDir: join(cfg.home, 'Projects'),
    stylesDirs: [STYLES],
    trustFile: join(cfg.home, 'trust.json'),
  });
  const h = createHandlers(engine, undefined, { settings: host } as never);
  return { cfg, host, h };
}

/** Every file under `dir`, as text. */
function allText(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p, 'utf8');
  }
  return out;
}

describe('settings host (phase 13 step 1, S18)', () => {
  it('the preset list matches the agent presets', () => {
    expect([...PRESET_IDS].sort()).toEqual([...presetIds].sort());
  });

  it('a typed key goes to the Keychain; the renderer and config see only the mask (canary)', async () => {
    const { cfg, h } = setup();
    const saved = (await h['settings.save']!({
      provider: { preset: 'openrouter', apiKey: CANARY_KEY },
    })) as SettingsData;
    expect(cfg.keychain.items.get('openrouter')).toBe(CANARY_KEY);
    const got = (await h['settings.get']!()) as SettingsData;
    for (const r of [saved, got]) {
      expect(JSON.stringify(r)).not.toContain(CANARY_KEY);
      expect(JSON.stringify(r)).not.toContain('CANARY');
      const or = r.providers.find((p) => p.id === 'openrouter');
      expect(or).toMatchObject({ keyRef: 'keychain' });
      expect(or?.keyMasked).toMatch(/…|\*/);
    }
    const config = readFileSync(join(cfg.home, 'config.json'), 'utf8');
    expect(config).toContain('keychain:openrouter');
    expect(allText(cfg.home)).not.toContain(CANARY_KEY);
  });

  it('a save with the key absent (masked field untouched) keeps the Keychain key', async () => {
    const { cfg, h } = setup();
    await h['settings.save']!({ provider: { preset: 'openrouter', apiKey: CANARY_KEY } });
    await h['settings.save']!({
      provider: { id: 'openrouter', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    });
    expect(cfg.keychain.items.get('openrouter')).toBe(CANARY_KEY);
    // the mask itself sent back is rejected by saveProvider or kept; never stored as the key
    const masked = ((await h['settings.get']!()) as SettingsData).providers.find(
      (p) => p.id === 'openrouter',
    )!.keyMasked!;
    await h['settings.save']!({ provider: { id: 'openrouter', apiKey: masked } }).catch(() => null);
    expect(cfg.keychain.items.get('openrouter')).toBe(CANARY_KEY);
  });

  it('a probe result carries no key; a log of the result through the redactor has no canary', async () => {
    const { cfg, h } = setup();
    await h['settings.save']!({ provider: { preset: 'openrouter', apiKey: CANARY_KEY } });
    const probed = await h['settings.probe']!('openrouter:gw/model');
    expect(JSON.stringify(probed)).not.toContain(CANARY_KEY);
    expect(cfg.redactor.redact(`key ${CANARY_KEY}`)).not.toContain(CANARY_KEY);
  });

  it('a model whose probe failed a role cannot be assigned that role (PROBE_FAILED)', async () => {
    const { h } = setup({ checks: { ...ALL_PASS, vision: fail('named the wrong colour') } });
    await h['settings.save']!({ provider: { preset: 'openrouter', apiKey: CANARY_KEY } });
    const probed = (await h['settings.probe']!('openrouter:gw/model')) as {
      roles: { role: string; assignable: boolean }[];
    };
    expect(probed.roles.find((r) => r.role === 'vision')?.assignable).toBe(false);
    await expect(
      h['settings.save']!({
        role: { role: 'vision', providerId: 'openrouter', model: 'gw/model' },
      }),
    ).rejects.toMatchObject({ code: 'PROBE_FAILED' });
    // the editor role passed, so it is assigned
    const s = (await h['settings.save']!({
      role: { role: 'editor', providerId: 'openrouter', model: 'gw/model' },
    })) as SettingsData;
    expect(s.roles.editor).toEqual({ providerId: 'openrouter', model: 'gw/model' });
    expect(s.roles.vision).toBeUndefined();
    const cleared = (await h['settings.save']!({ clearRole: 'editor' })) as SettingsData;
    expect(cleared.roles.editor).toBeUndefined();
  });

  it('a role is never assigned without a probe pass: an unprobed model is probed first', async () => {
    const { h } = setup({ checks: { ...ALL_PASS, tools: fail('no tool call') } });
    await h['settings.save']!({ provider: { preset: 'openrouter', apiKey: CANARY_KEY } });
    await expect(
      h['settings.save']!({
        role: { role: 'editor', providerId: 'openrouter', model: 'gw/model' },
      }),
    ).rejects.toMatchObject({ code: 'PROBE_FAILED' });
  });

  it.each(['ready', 'notEnabled', 'notEligible', 'modelNotReady', 'unsupportedOS'])(
    'the Apple row shows the helper status %s',
    async (status) => {
      const { host } = setup({ appleStatus: status });
      const s = await host.get();
      expect(s.apple).toMatchObject({ status, usable: status === 'ready' });
      expect(typeof s.apple?.hint === 'string' || status === 'ready').toBe(true);
    },
  );

  it('a build without the helper hides the Apple preset and refuses an Apple provider', async () => {
    const { h } = setup({ appleHelper: false });
    const s = (await h['settings.get']!()) as SettingsData;
    expect(s.appleHelper).toBe(false);
    expect(s.presets.map((p) => p.id)).not.toContain('apple');
    expect(s.apple).toBeUndefined();
    await expect(h['settings.save']!({ provider: { preset: 'apple' } })).rejects.toMatchObject({
      code: 'APPLE_UNAVAILABLE',
    });
  });

  it('Ollama lists its installed models; limits, prices and contact are saved', async () => {
    const { h } = setup();
    await h['settings.save']!({ provider: { preset: 'ollama' } });
    const s = (await h['settings.save']!({
      limits: { maxUsdPerRun: 2 },
      price: { model: 'gw/model', inPerMTok: 1, outPerMTok: 3 },
      contact: '  someone@example.com ',
    })) as SettingsData;
    expect(s.providers.find((p) => p.id === 'ollama')).toMatchObject({
      local: true,
      models: ['qwen3.5:latest'],
    });
    expect(s.limits.maxUsdPerRun).toBe(2);
    expect(s.prices['gw/model']).toEqual({ inPerMTok: 1, outPerMTok: 3 });
    expect(s.contact).toBe('someone@example.com');
  });

  it('parseRef keeps colons in Ollama model tags', () => {
    expect(parseRef('ollama:qwen3.5:latest')).toEqual({
      providerId: 'ollama',
      model: 'qwen3.5:latest',
    });
    expect(parseRef('editor')).toBeNull();
  });

  it('main rejects a settings patch with unknown fields (strict schema)', () => {
    expect(parseCall('settings.save', [{ provider: { preset: 'openrouter' }, evil: 1 }])).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(parseCall('settings.save', [{ roles: { editor: 'x' } }])).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(parseCall('settings.save', [{ cookiesFromBrowser: 'edge' }])).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(parseCall('settings.save', [{ cookiesFromBrowser: 'safari' }])).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });
});

describe('cookies toggle (phase 13 step 1b, S33)', () => {
  it('is off by default and written only through settings.save', async () => {
    const { cfg, h } = setup();
    expect(((await h['settings.get']!()) as SettingsData).ingest.cookiesFromBrowser).toBeNull();
    const on = (await h['settings.save']!({ cookiesFromBrowser: 'safari' })) as SettingsData;
    expect(on.ingest.cookiesFromBrowser).toBe('safari');
    const config = JSON.parse(readFileSync(join(cfg.home, 'config.json'), 'utf8')) as {
      ingest?: { cookiesFromBrowser?: unknown };
    };
    expect(config.ingest?.cookiesFromBrowser).toBe('safari');
    const off = (await h['settings.save']!({ cookiesFromBrowser: null })) as SettingsData;
    expect(off.ingest.cookiesFromBrowser).toBeNull();
  });

  it('no agent tool and no other window.vox method can carry the setting', () => {
    const registry = buildRegistry({ imageProviders: { list: () => [] } } as never);
    for (const name of registry.names()) {
      const schema = JSON.stringify(registry.modelSchema(name));
      expect(schema, name).not.toMatch(/cookie|config|keychain/i);
    }
    for (const method of Object.keys(METHOD_ARGS)) {
      if (method === 'settings.save') continue;
      const schema = JSON.stringify(z.toJSONSchema(METHOD_ARGS[method as Method], { io: 'input' }));
      expect(schema, method).not.toMatch(/cookiesFromBrowser/);
    }
  });
});
