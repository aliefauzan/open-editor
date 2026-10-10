import { describe, expect, test } from 'vitest';
import { isBlockedAddress, resolvePublic, systemResolver } from '../../src/net/address.ts';
import type { Resolver } from '../../src/net/address.ts';
import { VoxError } from '../../src/errors.ts';

const fake =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    const hit = table[host];
    if (hit === undefined) throw new Error(`ENOTFOUND ${host}`);
    return hit;
  };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VoxError) return e.code;
    throw e;
  }
  return 'OK';
}

describe('isBlockedAddress (S3, S29)', () => {
  test.each([
    // IPv4: this-network, private, CGNAT, loopback, link-local, IETF, benchmark, multicast, reserved
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.0.9',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6: unspecified, loopback, v4-compatible, v4-mapped, ULA, link-local, site-local, multicast
    '::',
    '::1',
    '::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%en0',
    'febf::1',
    'fec0::1',
    'ff02::1',
    // documentation, translation and tunnelling ranges
    '192.0.2.1',
    '192.88.99.1',
    '198.51.100.7',
    '203.0.113.9',
    '::ffff:0:7f00:1',
    '64:ff9b:1::a00:1',
    '100::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::1',
    // embedded IPv4 in 6to4 and NAT64 prefixes
    '2002:7f00:0001::1',
    '2002:c0a8:0101::',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    // not an IP at all: fail closed
    'example.com',
    '',
    '1.2.3',
    '999.1.1.1',
  ])('%s is blocked', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a03:2880:f12f:83:face:b00c:0:25de',
    '::ffff:8.8.8.8',
    '2002:0808:0808::1',
    '64:ff9b::808:808',
  ])('%s is allowed', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('resolvePublic (S3, S29)', () => {
  test('returns the checked address of a public name', async () => {
    await expect(resolvePublic('cdn.test', fake({ 'cdn.test': ['93.184.216.34'] }))).resolves.toBe(
      '93.184.216.34',
    );
  });

  test('refuses a name that resolves to 127.0.0.1', async () => {
    expect(await codeOf(resolvePublic('evil.test', fake({ 'evil.test': ['127.0.0.1'] })))).toBe(
      'NET_BLOCKED',
    );
  });

  test('refuses a name when any of its addresses is private (no mixed answers)', async () => {
    const r = fake({ 'mixed.test': ['93.184.216.34', '10.0.0.7'] });
    expect(await codeOf(resolvePublic('mixed.test', r))).toBe('NET_BLOCKED');
  });

  test('refuses private IP literals without asking the resolver', async () => {
    let calls = 0;
    const r: Resolver = async () => {
      calls += 1;
      return ['93.184.216.34'];
    };
    for (const host of ['127.0.0.1', '10.1.2.3', '[::1]', '::1', '169.254.169.254', '[fe80::1]']) {
      expect(await codeOf(resolvePublic(host, r))).toBe('NET_BLOCKED');
    }
    expect(calls).toBe(0);
  });

  test('accepts a public IP literal as is', async () => {
    await expect(resolvePublic('[2606:4700:4700::1111]', fake({}))).resolves.toBe(
      '2606:4700:4700::1111',
    );
    await expect(resolvePublic('8.8.8.8', fake({}))).resolves.toBe('8.8.8.8');
  });

  test('normalises case and a trailing dot before resolving', async () => {
    await expect(resolvePublic('CDN.Test.', fake({ 'cdn.test': ['93.184.216.34'] }))).resolves.toBe(
      '93.184.216.34',
    );
  });

  test('a failed or empty lookup is NET_DNS', async () => {
    expect(await codeOf(resolvePublic('nope.test', fake({})))).toBe('NET_DNS');
    expect(await codeOf(resolvePublic('empty.test', fake({ 'empty.test': [] })))).toBe('NET_DNS');
  });

  test('an empty host is URL_INVALID', async () => {
    expect(await codeOf(resolvePublic('', fake({})))).toBe('URL_INVALID');
  });

  test('the blocked error names host and address in details and has a hint', async () => {
    try {
      await resolvePublic('evil.test', fake({ 'evil.test': ['192.168.0.10'] }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(VoxError);
      const err = e as VoxError;
      expect(err.details).toEqual({ host: 'evil.test', address: '192.168.0.10' });
      expect(err.hint.length).toBeGreaterThan(0);
    }
  });

  test('the system resolver refuses localhost (real lookup, no network needed)', async () => {
    expect(await codeOf(resolvePublic('localhost', systemResolver))).toBe('NET_BLOCKED');
  });
});
