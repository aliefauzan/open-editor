// Phase 11 CLI: `vox config providers add|list|remove`, `roles set`, `prices set` and `probe`
// (step 10: a role whose probe failed is refused, `roles set` exits 1 naming the capability). Mock
// probe checks and an in-memory Keychain; no network, no real Keychain, no live model.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Keychain, OpenRouterModelInfo } from '@vox/agent';
import { describe, expect, test } from 'vitest';
import type { AgentCliDeps } from '../src/config.ts';
import { run, type Io } from '../src/main.ts';

// The R4 canary key (S19): it must never reach stdout, stderr or config.json.
const CANARY_KEY = 'sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000';
const FAKE_APPLE = fileURLToPath(
  new URL('../../agent/test/fixtures/fake-apple-llm.mjs', import.meta.url),
);

type Check = () => Promise<{ status: 'pass' } | { status: 'fail'; reason: string }>;
const pass: Check = () => Promise.resolve({ status: 'pass' });
const fail =
  (reason: string): Check =>
  () =>
    Promise.resolve({ status: 'fail', reason });

function memoryKeychain(): Keychain & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: (id) => Promise.resolve(items.get(id) ?? null),
    set: (id, key) => (items.set(id, key), Promise.resolve()),
    remove: (id) => (items.delete(id), Promise.resolve()),
  };
}

const MODELS = new Map<string, OpenRouterModelInfo>([
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
]);

function setup(checks: Record<string, Check> = {}, over: Partial<Io> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vox-config-'));
  const keychain = memoryKeychain();
  const agent: Partial<AgentCliDeps> = {
    keychain,
    apple: undefined,
    probe: {
      checks: { tools: pass, loop: pass, vision: pass, plan: pass, ...checks },
      context: { openRouterModels: MODELS },
    },
  };
  const env = { HOME: home, VOX_HOME: home, OPENROUTER_API_KEY: CANARY_KEY };
  const vox = async (args: string[], extra: Partial<Io> = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await run(args, {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env,
      cwd: home,
      agent,
      ...over,
      ...extra,
    });
    return { code, stdout, stderr };
  };
  const config = () =>
    JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
  return { vox, config, keychain, agent, home };
}

describe('vox config providers', () => {
  test('add with an env reference; list masks the key', async () => {
    const t = setup();
    const r = await t.vox([
      'config',
      'providers',
      'add',
      'openrouter',
      '--key',
      'env:OPENROUTER_API_KEY',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ id: 'openrouter', keyRef: 'env' });
    const l = await t.vox(['config', 'providers', 'list']);
    expect(l.stdout).toMatch(/^openrouter\topenrouter\thttps:\/\/openrouter\.ai\/api\/v1\tsk-or-/);
    for (const out of [r.stdout, l.stdout, JSON.stringify(t.config())]) {
      expect(out).not.toContain(CANARY_KEY);
    }
    expect(t.config()['providers']).toEqual([
      expect.objectContaining({ id: 'openrouter', apiKey: 'env:OPENROUTER_API_KEY' }),
    ]);
  });

  test('a key on the command line is refused (S17); without a terminal the key cannot be asked', async () => {
    const t = setup();
    const lit = await t.vox(['config', 'providers', 'add', 'claude', '--key', CANARY_KEY]);
    expect(lit.code).toBe(2);
    expect(lit.stderr).toContain('--key takes only env:NAME');
    expect(lit.stderr).not.toContain(CANARY_KEY);
    const noTty = await t.vox(['config', 'providers', 'add', 'claude']);
    expect(noTty.code).toBe(2);
    expect(noTty.stderr).toContain('needs --key env:NAME');
    const keyless = await t.vox(['config', 'providers', 'add', 'ollama', '--key', 'env:X_API_KEY']);
    expect(keyless.code).toBe(2);
  });

  test('a typed key goes to the Keychain; the config holds only the reference', async () => {
    const t = setup();
    const asked: string[] = [];
    const r = await t.vox(['config', 'providers', 'add', 'claude'], {
      isTTY: true,
      promptSecret: (q) => (asked.push(q), Promise.resolve(`  ${CANARY_KEY}\n`)),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(asked).toEqual(['Claude (Anthropic API key) API key (hidden): ']);
    expect(t.keychain.items.get('claude')).toBe(CANARY_KEY);
    expect(r.stdout).toMatch(/^added claude \(Claude \(Anthropic API key\)\), key sk-or-/);
    expect(r.stdout).not.toContain(CANARY_KEY);
    expect(t.config()['providers']).toEqual([
      expect.objectContaining({ apiKey: 'keychain:claude' }),
    ]);
    const rm = await t.vox(['config', 'providers', 'remove', 'claude']);
    expect(rm.code).toBe(0);
    expect(t.keychain.items.has('claude')).toBe(false);
  });

  test('ollama with --num-ctx and --context; an unknown preset is a usage error', async () => {
    const t = setup();
    const r = await t.vox([
      'config',
      'providers',
      'add',
      'ollama',
      '--num-ctx',
      '16384',
      '--context',
      'qwen3:8b=40960',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(t.config()['providers']).toEqual([
      expect.objectContaining({
        id: 'ollama',
        options: { numCtx: 16384, contextTokens: { 'qwen3:8b': 40960 } },
      }),
    ]);
    expect((await t.vox(['config', 'providers', 'add', 'nope'])).code).toBe(2);
    expect((await t.vox(['config', 'providers', 'add', 'ollama', '--context', 'x'])).code).toBe(2);
  });

  test('apple: refused with the reason when the helper is missing or the model is not ready', async () => {
    const t = setup();
    const missing = await t.vox(['config', 'providers', 'add', 'apple', '--json']);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error.code).toBe('APPLE_UNAVAILABLE');
    t.agent.apple = {
      command: process.execPath,
      args: [FAKE_APPLE],
      env: { VOX_FAKE_APPLE_STATUS: 'notEnabled' },
    };
    const off = await t.vox(['config', 'providers', 'add', 'apple']);
    expect(off.code).toBe(1);
    expect(off.stderr).toMatch(
      /^error: the Apple on-device model is notEnabled\nhint: Turn on Apple Intelligence/,
    );
    t.agent.apple = { command: process.execPath, args: [FAKE_APPLE] };
    const ok = await t.vox(['config', 'providers', 'add', 'apple', '--json']);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ id: 'apple', type: 'apple', keyRef: 'none' });
  });
});

describe('vox config roles set and probe (step 10)', () => {
  test('a model that passes is assigned (editor in tools mode)', async () => {
    const t = setup();
    await t.vox(['config', 'providers', 'add', 'openrouter', '--key', 'env:OPENROUTER_API_KEY']);
    const r = await t.vox(['config', 'roles', 'set', 'editor', 'openrouter:gw/model', '--json']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      role: 'editor',
      providerId: 'openrouter',
      model: 'gw/model',
      mode: 'tools',
    });
    expect(t.config()['roles']).toEqual({
      editor: { providerId: 'openrouter', model: 'gw/model' },
    });
    const plan = await t.vox([
      'config',
      'roles',
      'set',
      'editor',
      'openrouter:gw/model',
      '--mode',
      'plan',
    ]);
    expect(plan.stdout).toBe('editor: openrouter:gw/model (plan mode)\n');
  });

  test('a failed capability is refused: exit 1 naming it, the role is not written', async () => {
    const t = setup({ vision: fail('named the wrong colour') });
    await t.vox(['config', 'providers', 'add', 'openrouter', '--key', 'env:OPENROUTER_API_KEY']);
    const r = await t.vox(['config', 'roles', 'set', 'vision', 'openrouter:gw/model']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('vision fail (named the wrong colour)');
    expect(r.stderr).toMatch(/error: .*vision/);
    const j = await t.vox(['config', 'roles', 'set', 'vision', 'openrouter:gw/model', '--json']);
    expect(j.code).toBe(1);
    expect(JSON.parse(j.stdout).error).toMatchObject({
      code: 'PROBE_FAILED',
      message: expect.stringContaining('vision'),
    });
    expect(t.config()['roles'] ?? {}).toEqual({});
    // the editor still passes on the same model
    expect((await t.vox(['config', 'roles', 'set', 'editor', 'openrouter:gw/model'])).code).toBe(0);
  });

  test('an unpriced paid model cannot be assigned until priced (prices set)', async () => {
    const t = setup();
    await t.vox([
      'config',
      'providers',
      'add',
      'claude',
      '--key',
      'env:OPENROUTER_API_KEY',
      '--context',
      'claude-x=200000',
    ]);
    const r = await t.vox(['config', 'roles', 'set', 'fast', 'claude:claude-x', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      code: 'PRICE_MISSING',
      details: { model: 'claude-x', role: 'fast' },
    });
    const p = await t.vox(['config', 'prices', 'set', 'claude-x', '--in', '3', '--out', '15']);
    expect(p.code, p.stderr).toBe(0);
    expect(p.stdout).toBe('claude-x: $3 in, $15 out per million tokens\n');
    expect((await t.vox(['config', 'roles', 'set', 'fast', 'claude:claude-x'])).code).toBe(0);
    expect((await t.vox(['config', 'prices', 'set', 'claude-x', '--free', '--in', '1'])).code).toBe(
      2,
    );
  });

  test('probe reports each role model; a provider answer quoting the key is redacted (S19)', async () => {
    const t = setup({ loop: fail(`provider said: bad key ${CANARY_KEY}`) });
    await t.vox(['config', 'providers', 'add', 'openrouter', '--key', 'env:OPENROUTER_API_KEY']);
    const none = await t.vox(['config', 'probe']);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('nothing to probe');
    const r = await t.vox(['config', 'probe', 'openrouter:gw/model']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      'openrouter:gw/model\n  tools pass\n  loop fail (provider said: bad key [REDACTED])\n',
    );
    expect(r.stdout).toContain('  context 128000 (openrouter)\n');
    expect(r.stdout).toMatch(/ {2}tool list \d+ tokens: pass\n/);
    expect(r.stdout).toContain('  roles: editor (plan), vision, fast\n');
    expect(r.stdout).not.toContain(CANARY_KEY);
    const j = await t.vox(['config', 'probe', 'openrouter:gw/model', '--json']);
    const [one] = JSON.parse(j.stdout) as { report: Record<string, unknown> }[];
    expect(one!.report).toMatchObject({
      tools: { status: 'pass' },
      loop: { status: 'fail' },
      context: { contextTokens: 128000 },
    });
    expect(j.stdout).not.toContain(CANARY_KEY);
    const missingKey = await t.vox(['config', 'probe', 'openrouter:gw/model', '--json'], {
      env: { HOME: t.home, VOX_HOME: t.home },
    });
    expect(missingKey.code).toBe(1);
    expect(JSON.parse(missingKey.stdout)[0].error.code).toBeTruthy();
  });
});
