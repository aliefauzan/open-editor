// Step 1 (S17, S18, S30): provider entries, roles and limits through the engine config module.
import { configPath, readConfig, writeConfig } from '@vox/engine';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createSecurityKeychain, type RunProcess } from '../../src/config/keychain.ts';
import {
  DEFAULT_LIMITS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  loadAgentConfig,
  maskedProviders,
  providerKey,
  removeProvider,
  saveProvider,
  setLimits,
  setPrice,
  setRole,
} from '../../src/config/store.ts';
import { CANARY_KEY } from '../helpers/canary.ts';
import { configDeps } from '../helpers/fakes.ts';

const fileText = (home: string) => readFileSync(configPath({ VOX_HOME: home }), 'utf8');

describe('agent config store', () => {
  test('defaults: $2.00 and 60 steps; per-role output caps 8,000/2,000/2,000', async () => {
    const d = configDeps();
    const cfg = await loadAgentConfig(d);
    expect(cfg.limits).toEqual({ maxUsdPerRun: 2, maxStepsPerRun: 60 });
    expect(DEFAULT_LIMITS).toEqual(cfg.limits);
    expect(cfg.maxOutputTokens).toMatchObject({ editor: 8000, vision: 2000, fast: 2000 });
    expect(DEFAULT_MAX_OUTPUT_TOKENS.editor).toBe(8000);
  });

  test('a typed key goes to the Keychain; the file holds keychain:<id> and mode 0600', async () => {
    const d = configDeps();
    const e = await saveProvider(d, { preset: 'openrouter', apiKey: CANARY_KEY });
    expect(e.apiKey).toBe('keychain:openrouter');
    expect(d.keychain.items.get('openrouter')).toBe(CANARY_KEY);
    expect(fileText(d.home)).not.toContain(CANARY_KEY);
    expect(statSync(configPath({ VOX_HOME: d.home })).mode & 0o777).toBe(0o600);
    expect(d.redactor.redact(`x ${CANARY_KEY}`)).not.toContain(CANARY_KEY);
  });

  test('an agent save keeps contact and projectsDir (fields the engine owns)', async () => {
    const d = configDeps();
    const env = { VOX_HOME: d.home, HOME: d.home };
    await writeConfig({ contact: 'owner@example.org', projectsDir: '/tmp/projects' }, env);
    await saveProvider(d, { preset: 'ollama' });
    await setLimits(d, { maxUsdPerRun: 3 });
    const c = await readConfig(env);
    expect(c.contact).toBe('owner@example.org');
    expect(c.projectsDir).toBe('/tmp/projects');
    expect(c.limits?.maxUsdPerRun).toBe(3);
  });

  test('masked or absent key on save = unchanged (S18)', async () => {
    const d = configDeps();
    await saveProvider(d, { preset: 'openrouter', apiKey: CANARY_KEY });
    const [m] = await maskedProviders(d);
    expect(m?.keyMasked).toBe(`sk-or-…${CANARY_KEY.slice(-4)}`);
    expect(JSON.stringify(m)).not.toContain(CANARY_KEY);
    await saveProvider(d, { id: 'openrouter', apiKey: m?.keyMasked ?? null });
    await saveProvider(d, { id: 'openrouter' });
    await saveProvider(d, { id: 'openrouter', apiKey: '' });
    expect(d.keychain.items.get('openrouter')).toBe(CANARY_KEY);
    expect((await loadAgentConfig(d)).providers[0]?.apiKey).toBe('keychain:openrouter');
  });

  test('keyless presets store no apiKey and refuse a key', async () => {
    const d = configDeps();
    for (const preset of ['lmstudio', 'ollama', 'apple'] as const) {
      const e = await saveProvider(d, { preset });
      expect(e.apiKey).toBeUndefined();
      await expect(saveProvider(d, { id: preset, apiKey: CANARY_KEY })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
    }
    expect(d.keychain.items.size).toBe(0);
  });

  test('env: references must name an *_API_KEY variable (S17)', async () => {
    const d = configDeps({ env: { OPENROUTER_API_KEY: CANARY_KEY } });
    const e = await saveProvider(d, { preset: 'openrouter', apiKey: 'env:OPENROUTER_API_KEY' });
    expect(e.apiKey).toBe('env:OPENROUTER_API_KEY');
    expect(await providerKey(d, e)).toBe(CANARY_KEY);
    await expect(
      saveProvider(d, { id: 'openrouter', apiKey: 'env:AWS_SECRET_ACCESS_KEY' }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  test.each([
    'https://user:pw@openrouter.ai/api/v1',
    'https://openrouter.ai/api/v1?api_key=abc',
    'https://openrouter.ai/api/v1#frag',
    'http://gateway.example.com/v1',
  ])('baseUrl %s is rejected for a keyed provider (S17)', async (baseUrl) => {
    const d = configDeps();
    await expect(saveProvider(d, { preset: '9router', baseUrl })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    const text = await d.io.read();
    expect(JSON.stringify(text)).not.toContain('gateway');
  });

  test('plain http is fine on localhost and for keyless providers on the LAN', async () => {
    const d = configDeps();
    await saveProvider(d, { preset: '9router', baseUrl: 'http://127.0.0.1:20128/v1' });
    await saveProvider(d, { id: 'lan', preset: 'ollama', baseUrl: 'http://192.168.1.20:11434' });
    expect((await loadAgentConfig(d)).providers).toHaveLength(2);
  });

  test('a raw key written into the file by hand fails loading with no key text', async () => {
    const d = configDeps();
    await d.io.write({ providers: [{ id: 'openrouter', type: 'openrouter', apiKey: CANARY_KEY }] });
    const err = await loadAgentConfig(d).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(CANARY_KEY);
  });

  test('providerKey registers the key with the redactor as soon as it is read', async () => {
    const d = configDeps();
    d.keychain.items.set('claude', CANARY_KEY);
    await d.io.write({
      providers: [{ id: 'claude', type: 'anthropic', preset: 'claude', apiKey: 'keychain:claude' }],
    });
    const e = (await loadAgentConfig(d)).providers[0]!;
    const seen: string[] = [];
    const fresh = {
      ...d,
      redactor: { addSecrets: (v: readonly string[]) => void seen.push(...v) },
    };
    expect(await providerKey(fresh, e)).toBe(CANARY_KEY);
    expect(seen).toEqual([CANARY_KEY]);
  });

  test('a keyed provider with no stored key fails with CONFIG_INVALID', async () => {
    const d = configDeps();
    const e = await saveProvider(d, { preset: 'claude' });
    await expect(providerKey(d, e)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  test('setRole refuses a verdict that is not assignable; stores an assignable one', async () => {
    const d = configDeps();
    await saveProvider(d, { preset: 'ollama' });
    const ref = { providerId: 'ollama', model: 'qwen3:8b' };
    await expect(
      setRole(d, 'editor', ref, {
        role: 'editor',
        assignable: false,
        failures: [{ check: 'plan', reason: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'PROBE_FAILED' });
    await setRole(d, 'fast', ref, { role: 'fast', assignable: true, failures: [] });
    expect((await loadAgentConfig(d)).roles.fast).toEqual(ref);
  });

  test('removeProvider drops the entry, its Keychain item and its roles', async () => {
    const d = configDeps();
    await saveProvider(d, { preset: 'openrouter', apiKey: CANARY_KEY });
    await setRole(
      d,
      'fast',
      { providerId: 'openrouter', model: 'm' },
      { role: 'fast', assignable: true, failures: [] },
    );
    await removeProvider(d, 'openrouter');
    const cfg = await loadAgentConfig(d);
    expect(cfg.providers).toEqual([]);
    expect(cfg.roles.fast).toBeUndefined();
    expect(d.keychain.items.size).toBe(0);
  });

  test('setPrice replaces a price as a whole (free after priced)', async () => {
    const d = configDeps();
    await setPrice(d, 'vendor/model', { inPerMTok: 1, outPerMTok: 2, cacheReadPerMTok: 0.1 });
    await setPrice(d, 'vendor/model', { free: true });
    expect((await loadAgentConfig(d)).prices['vendor/model']).toEqual({ free: true });
  });

  test('S30: through the real security keychain, the key is only on stdin of `security -i`', async () => {
    const calls: { file: string; args: readonly string[]; input?: string }[] = [];
    const run: RunProcess = (file, args, opts = {}) => {
      calls.push({ file, args, ...(opts.input !== undefined && { input: opts.input }) });
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    const d = configDeps({ keychain: createSecurityKeychain({ service: 'Vox Studio Test', run }) });
    await saveProvider(d, { preset: 'openrouter', apiKey: CANARY_KEY });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(JSON.stringify([c.file, ...c.args])).not.toContain(CANARY_KEY);
    expect(calls.some((c) => c.args.includes('-i') && c.input?.includes(CANARY_KEY))).toBe(true);
  });
});
