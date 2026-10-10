// Private-address check (engine spec "Ingest hardening"; R4 S3, S29).
// A host is resolved once; every address it returns must be public, and callers connect to the
// address returned here, so there is no DNS-rebinding window between check and connect.

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { VoxError } from '../errors.pending.ts';

/** Resolves a host name to its addresses. Injected in tests; the default asks the OS. */
export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (shared)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Expands an IPv6 address (no zone) into 8 hextets, or undefined when it does not parse. */
function hextets(ip: string): number[] | undefined {
  let s = ip;
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = quad.slice(2).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return undefined;
    s = `${quad[1] ?? ''}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return undefined;
  const out = [...head, ...Array<string>(fill).fill('0'), ...tail].map((x) =>
    /^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN,
  );
  return out.every((n) => !Number.isNaN(n)) ? out : undefined;
}

function v4From(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * True when `ip` must never be connected to: private, loopback, link-local, multicast and other
 * non-public ranges, IPv4 embedded in IPv6 (mapped, 6to4, NAT64) included. Anything that is not an IP
 * address is blocked too (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true;
  if (ip.includes('%')) return true; // zone ids only exist on link-local scopes
  if (blocked.check(ip, 'ipv6')) return true; // also covers ::ffff:a.b.c.d (BlockList maps it)
  const h = hextets(ip.toLowerCase());
  if (h === undefined) return true;
  // 6to4 (2002::/16): IPv4 in hextets 1-2. NAT64 (64:ff9b::/96): IPv4 in hextets 6-7.
  if (h[0] === 0x2002) return blocked.check(v4From(h[1] ?? 0, h[2] ?? 0), 'ipv4');
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return blocked.check(v4From(h[6] ?? 0, h[7] ?? 0), 'ipv4');
  }
  // IPv4-mapped written in hex (::ffff:7f00:1) is caught by BlockList; check explicitly anyway.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return blocked.check(v4From(h[6] ?? 0, h[7] ?? 0), 'ipv4');
  }
  return false;
}

/** Lower-cases, strips IPv6 brackets and one trailing dot. */
export function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

const BLOCKED_HINT =
  'Vox Studio only downloads from public internet addresses. Use a public link, or download the file yourself and add it as a local file.';

/**
 * Resolves `host` once and returns the address to connect to. Throws `NET_BLOCKED` when the host is
 * (or any of its addresses is) non-public, `NET_DNS` when it does not resolve.
 */
export async function resolvePublic(
  host: string,
  resolver: Resolver = systemResolver,
): Promise<string> {
  const h = normaliseHost(host);
  if (h === '') {
    throw new VoxError(
      'URL_INVALID',
      'The link has no host name.',
      'Check the link and try again.',
    );
  }
  if (isIP(h) !== 0 || h.includes(':')) {
    if (isBlockedAddress(h)) {
      throw new VoxError('NET_BLOCKED', `Refused a non-public address: ${h}`, BLOCKED_HINT, {
        details: { host: h, address: h },
      });
    }
    return h;
  }
  let addresses: string[];
  try {
    addresses = await resolver(h);
  } catch (cause) {
    throw new VoxError(
      'NET_DNS',
      `Could not resolve ${h}.`,
      'Check the link and your internet connection.',
      {
        cause,
        details: { host: h },
      },
    );
  }
  if (addresses.length === 0) {
    throw new VoxError(
      'NET_DNS',
      `${h} has no address.`,
      'Check the link and your internet connection.',
      {
        details: { host: h },
      },
    );
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new VoxError(
        'NET_BLOCKED',
        `Refused ${h}: it resolves to a non-public address (${address}).`,
        BLOCKED_HINT,
        { details: { host: h, address } },
      );
    }
  }
  return addresses[0] as string;
}
