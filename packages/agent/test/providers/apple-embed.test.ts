// On-device embeddings through the Apple helper (D-77) against the fake helper: the `--embed`
// protocol, the embedder (`local`, chunking, cutting), its errors, the `embed` flag of `--status`
// in the probe and the role rules, and the default embedder when no embed role is set. The real
// helper: apple-helper.local.test.ts.
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildEmbedder } from '../../src/config/run-models.ts';
import { loadAgentConfig } from '../../src/config/store.ts';
import { VoxError } from '../../src/errors.ts';
import {
  appleEmbed,
  appleStatus,
  createAppleEmbedder,
  type AppleModelOptions,
} from '../../src/providers/apple.ts';
import {
  APPLE_EMBED_MAX_TEXTS,
  AppleEmbedAnswer,
  AppleEmbedRequest,
  appleErrorCodes,
  parseAppleEmbedLine,
  parseAppleStatusLine,
} from '../../src/providers/apple-protocol.ts';
import { createEmbedder } from '../../src/providers/factory.ts';
import { providerEntryFromPreset } from '../../src/providers/presets.ts';
import { roleCheck, type ProbeReport } from '../../src/providers/roles.ts';
import { probeModel } from '../../src/providers/run-probe.ts';
import { cosine } from '../../src/screenplay/match.ts';
import { configDeps } from '../helpers/fakes.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-apple-llm.mjs', import.meta.url));
const fake = (env: Record<string, string> = {}, extra: Partial<AppleModelOptions> = {}) => ({
  command: process.execPath,
  args: [FAKE],
  env,
  ...extra,
});
const on = fake({ VOX_FAKE_APPLE_EMBED: '1' });

async function voxError(p: Promise<unknown>): Promise<VoxError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VoxError);
  return err as VoxError;
}

describe('--embed protocol (D-77)', () => {
  test('request: texts 1..512 of at most 4000 characters, an optional BCP 47 language', () => {
    expect(AppleEmbedRequest.safeParse({ texts: ['a'] }).success).toBe(true);
    expect(AppleEmbedRequest.safeParse({ texts: ['a'], language: 'id' }).success).toBe(true);
    expect(AppleEmbedRequest.safeParse({ texts: ['a'], language: 'zh-Hans' }).success).toBe(true);
    expect(AppleEmbedRequest.safeParse({ texts: [] }).success).toBe(false);
    expect(AppleEmbedRequest.safeParse({ texts: ['a'], language: 'english!' }).success).toBe(false);
    expect(AppleEmbedRequest.safeParse({ texts: ['a'], extra: 1 }).success).toBe(false);
    expect(AppleEmbedRequest.safeParse({ texts: ['x'.repeat(4001)] }).success).toBe(false);
    expect(
      AppleEmbedRequest.safeParse({ texts: new Array<string>(APPLE_EMBED_MAX_TEXTS + 1).fill('a') })
        .success,
    ).toBe(false);
  });

  test('answer: one vector per text, each dim long; an error line is an answer too', () => {
    expect(
      AppleEmbedAnswer.safeParse({ vectors: [[0.1, 0.2]], dim: 2, language: 'en' }).success,
    ).toBe(true);
    expect(AppleEmbedAnswer.safeParse({ vectors: [[0.1]], dim: 2, language: 'en' }).success).toBe(
      false,
    );
    const err = parseAppleEmbedLine('{"error":{"code":"assetsMissing","message":"no assets"}}\n');
    expect(err).toEqual({
      ok: true,
      value: { error: { code: 'assetsMissing', message: 'no assets' } },
    });
    expect(parseAppleEmbedLine('{"vectors":[],"dim":0,"language":"en"}').ok).toBe(false);
    expect(appleErrorCodes).toContain('assetsMissing');
  });

  test('--status: `embed` is optional (older helpers send none)', () => {
    const line = '{"status":"notEnabled","contextSize":4096,"vision":false,"embed":true}';
    expect(parseAppleStatusLine(line)).toMatchObject({ ok: true, value: { embed: true } });
  });
});

describe('Apple embedder (fake helper)', () => {
  test('vectors in order, one helper run, marked local; shared words score higher', async () => {
    const embed = createAppleEmbedder(on);
    expect(embed.local).toBe(true);
    const v = await embed([
      'the storm will not stop before dawn',
      'the storm stops before dawn',
      'quarterly revenue figures',
    ]);
    expect(v).toHaveLength(3);
    expect(v[0]).toHaveLength(16);
    expect(cosine(v[0]!, v[1]!)).toBeGreaterThan(cosine(v[0]!, v[2]!));
    expect(await embed([])).toEqual([]);
  });

  test('more than 512 texts go in several runs; long texts are cut; the language is kept', async () => {
    const texts = Array.from({ length: APPLE_EMBED_MAX_TEXTS + 3 }, (_, i) =>
      i === 0 ? 'word '.repeat(2000) : `text ${String(i)}`,
    );
    const r = await appleEmbed(on, texts, { language: 'id' });
    expect(r.vectors).toHaveLength(texts.length);
    expect(r).toMatchObject({ dim: 16, language: 'id' });
  });

  test('errors: assets missing, unavailable, a helper without --embed, no helper', async () => {
    const assets = await voxError(
      appleEmbed(fake({ VOX_FAKE_APPLE_EMBED: '1', VOX_FAKE_APPLE_EMBED_ERROR: 'assetsMissing' }), [
        'a',
      ]),
    );
    expect(assets.code).toBe('APPLE_UNAVAILABLE');
    expect(assets.details).toMatchObject({ status: 'assetsMissing' });
    expect(assets.hint).toMatch(/download/);
    const off = await voxError(appleEmbed(fake({ VOX_FAKE_APPLE_EMBED: '0' }), ['a']));
    expect(off.code).toBe('APPLE_UNAVAILABLE');
    const old = await voxError(appleEmbed(fake(), ['a']));
    expect(old.code).toBe('APPLE_UNAVAILABLE');
    expect(old.details).toMatchObject({ status: 'noEmbed' });
    const missing = await voxError(appleEmbed({ command: '/nonexistent/vox-apple-llm' }, ['a']));
    expect(missing.code).toBe('APPLE_UNAVAILABLE');
  });

  test('a cancelled call rejects with the abort reason', async () => {
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(createAppleEmbedder(on)(['a'], stop.signal)).rejects.toThrow('stopped');
  });
});

describe('embed flag in the probe and the role rules', () => {
  const e = providerEntryFromPreset('apple');
  const model = {} as never;

  test('the probe records embeddings from --status, even when Apple Intelligence is off', async () => {
    const off = await probeModel(e, 'apple-on-device', model, {
      apple: fake({ VOX_FAKE_APPLE_STATUS: 'notEnabled', VOX_FAKE_APPLE_EMBED: '1' }),
    });
    expect(off).toMatchObject({ appleStatus: 'notEnabled', capabilities: { embeddings: true } });
    const old = await probeModel(e, 'apple-on-device', model, {
      apple: fake({ VOX_FAKE_APPLE_STATUS: 'notEnabled' }),
    });
    expect(old.capabilities).toEqual({ embeddings: false });
  });

  test('embed is an Apple role only when the helper can embed; the model status does not matter', () => {
    const check = (probe: ProbeReport) =>
      roleCheck('embed', { provider: e, model: 'apple-on-device', probe, priceTables: [] });
    expect(check({ appleStatus: 'notEnabled', capabilities: { embeddings: true } })).toMatchObject({
      assignable: true,
      failures: [],
    });
    expect(check({ appleStatus: 'ready', capabilities: { embeddings: false } }).failures).toEqual([
      { check: 'embeddings', reason: 'the model has no embeddings' },
    ]);
    // the fast role still needs a ready model
    expect(
      roleCheck('fast', {
        provider: e,
        model: 'apple-on-device',
        probe: { appleStatus: 'notEnabled', capabilities: { embeddings: true } },
        priceTables: [],
      }).failures.map((f) => f.check),
    ).toContain('apple');
  });
});

describe('the embedder for a run', () => {
  test('no embed role: the Apple helper when --status says embed, else none', async () => {
    const d = configDeps();
    const conf = await loadAgentConfig(d);
    expect((await appleStatus(on)).embed).toBe(true);
    const local = await buildEmbedder(conf, d, { apple: on });
    expect(local?.local).toBe(true);
    expect(await buildEmbedder(conf, d, { apple: fake({ VOX_FAKE_APPLE_EMBED: '0' }) })).toBe(
      undefined,
    );
    expect(await buildEmbedder(conf, d, { apple: fake() })).toBe(undefined);
    expect(await buildEmbedder(conf, d, { apple: { command: '/nonexistent/x' } })).toBe(undefined);
    expect(await buildEmbedder(conf, d)).toBe(undefined);
  });

  test('embed role set to Apple: the helper embedder; without the helper CONFIG_INVALID', async () => {
    const d = configDeps();
    const conf = await loadAgentConfig(d);
    const withRole = {
      ...conf,
      providers: [providerEntryFromPreset('apple')],
      roles: { embed: { providerId: 'apple', model: 'apple-on-device' } },
    };
    const embed = await buildEmbedder(withRole, d, { apple: on });
    expect(embed?.local).toBe(true);
    expect(await embed!(['a b c'])).toHaveLength(1);
    expect(() =>
      createEmbedder(providerEntryFromPreset('apple'), 'apple-on-device', { apiKey: null }),
    ).toThrow(/not available here/);
  });
});
