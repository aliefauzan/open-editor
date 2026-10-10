import { describe, expect, it } from 'vitest';
import {
  assertSafeBaseUrl,
  formatKeyRef,
  isMaskedKey,
  keyInputIsUnchanged,
  maskKey,
  parseKeyRef,
} from '../../src/config/mask.ts';
import { CANARY_KEY } from '../helpers/canary.ts';

describe('maskKey', () => {
  it('shows the vendor prefix and the last four characters', () => {
    expect(maskKey('sk-or-v1-0123456789abcdef0123456789abcdefa1b2')).toBe('sk-or-…a1b2');
    expect(maskKey('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ9876')).toBe('sk-ant-…9876');
    expect(maskKey('AIzaSyD-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345')).toBe('…2345');
  });

  it('never reveals the middle of the canary key', () => {
    const m = maskKey(CANARY_KEY);
    expect(m).toBe('sk-or-…0000');
    expect(m).not.toContain('CANARY');
  });

  it('shows nothing of a short key', () => {
    expect(maskKey('abc')).toBe('…');
    expect(maskKey('sk-1234567')).toBe('…');
    expect(maskKey('')).toBe('…');
  });
});

describe('isMaskedKey and keyInputIsUnchanged', () => {
  it('recognises a masked form', () => {
    expect(isMaskedKey('sk-or-…a1b2')).toBe(true);
    expect(isMaskedKey('…2345')).toBe(true);
    expect(isMaskedKey('…')).toBe(true);
    expect(isMaskedKey(maskKey(CANARY_KEY))).toBe(true);
  });

  it('does not take a real key for a masked one', () => {
    expect(isMaskedKey(CANARY_KEY)).toBe(false);
    expect(isMaskedKey('sk-or-v1-abc')).toBe(false);
    expect(isMaskedKey('keychain:openrouter')).toBe(false);
  });

  it('treats absent, empty and masked input as unchanged', () => {
    expect(keyInputIsUnchanged(undefined)).toBe(true);
    expect(keyInputIsUnchanged(null)).toBe(true);
    expect(keyInputIsUnchanged('')).toBe(true);
    expect(keyInputIsUnchanged('  ')).toBe(true);
    expect(keyInputIsUnchanged('sk-or-…a1b2')).toBe(true);
  });

  it('treats a real key as a change', () => {
    expect(keyInputIsUnchanged(CANARY_KEY)).toBe(false);
    expect(keyInputIsUnchanged('env:OPENROUTER_API_KEY')).toBe(false);
  });
});

describe('key refs', () => {
  it('formats and parses keychain and env refs', () => {
    expect(formatKeyRef({ kind: 'keychain', providerId: 'openrouter' })).toBe(
      'keychain:openrouter',
    );
    expect(formatKeyRef({ kind: 'env', name: 'OPENROUTER_API_KEY' })).toBe(
      'env:OPENROUTER_API_KEY',
    );
    expect(parseKeyRef('keychain:my-provider.2')).toEqual({
      kind: 'keychain',
      providerId: 'my-provider.2',
    });
    expect(parseKeyRef('env:OPENROUTER_API_KEY')).toEqual({
      kind: 'env',
      name: 'OPENROUTER_API_KEY',
    });
  });

  it.each([
    'sk-or-v1-abc',
    CANARY_KEY,
    'keychain:',
    'keychain:a b',
    'keychain:a"b',
    'keychain:a\nb',
    'env:',
    'env:lower_case',
    'env:1ABC',
    'env:A-B',
    'file:/etc/passwd',
    '',
  ])('rejects %j as a key ref', (ref) => {
    expect(parseKeyRef(ref)).toBeNull();
  });

  it('refuses to format an unsafe provider id or env name', () => {
    expect(() => formatKeyRef({ kind: 'keychain', providerId: 'a b' })).toThrow();
    expect(() => formatKeyRef({ kind: 'env', name: 'bad name' })).toThrow();
  });
});

describe('assertSafeBaseUrl (S17)', () => {
  it.each([
    'https://openrouter.ai/api/v1',
    'http://localhost:11434',
    'http://localhost:1234/v1',
    'http://127.0.0.1:20128/v1/',
    'https://opencode.ai/zen/v1',
    'https://api.example.com/v1?api-version=2024-06-01',
    'http://[::1]:8080/v1',
  ])('accepts %s', (url) => {
    expect(() => assertSafeBaseUrl(url)).not.toThrow();
  });

  it.each([
    ['userinfo', 'https://user:pass@example.com/v1'],
    ['username only', 'https://sk-or-v1-abc@example.com/v1'],
    ['key query', 'https://example.com/v1?key=abc'],
    ['api_key query', 'https://example.com/v1?api_key=abc'],
    ['apiKey query', 'https://example.com/v1?apiKey=abc'],
    ['api-key query', 'https://example.com/v1?api-key=abc'],
    ['token query', 'https://example.com/v1?token=abc'],
    ['access_token query', 'https://example.com/v1?access_token=abc'],
    ['secret query', 'https://example.com/v1?client_secret=abc'],
    ['password query', 'https://example.com/v1?password=abc'],
    ['uppercase query', 'https://example.com/v1?KEY=abc'],
    ['key in second param', 'https://example.com/v1?a=1&key=abc'],
    ['key-like value', 'https://example.com/v1?x=sk-or-v1-abcdef0123456789'],
    ['key in fragment', 'https://example.com/v1#api_key=abc'],
    ['canary in path', `https://example.com/${CANARY_KEY}/v1`],
    ['file scheme', 'file:///etc/passwd'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['not a url', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_n, url) => {
    try {
      assertSafeBaseUrl(url);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('CONFIG_INVALID');
      expect((e as { hint?: string }).hint).toBeTruthy();
      // the error never echoes a credential
      expect(String((e as Error).message)).not.toContain('abc');
      expect(String((e as Error).message)).not.toContain('CANARY');
      expect(String((e as Error).message)).not.toContain('user:pass');
    }
  });
});
