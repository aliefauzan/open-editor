import { describe, expect, test } from 'vitest';
import { loadManifest, validateManifest } from '../../src/engine-host/setup/manifest.ts';

describe('manifest.json', () => {
  const m = loadManifest();

  test('pins uv and deno by exact version and SHA-256 over https GitHub release URLs', () => {
    for (const id of ['uv', 'deno']) {
      const c = m.components.find((x) => x.id === id);
      expect(c?.kind).toBe('archive');
      if (c?.kind !== 'archive') throw new Error('unreachable');
      expect(c.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(c.url).toMatch(
        /^https:\/\/github\.com\/(astral-sh\/uv|denoland\/deno)\/releases\/download\//,
      );
      expect(c.url).toContain('aarch64-apple-darwin');
      expect(c.url).toContain(id === 'deno' ? `v${c.version}` : c.version);
      expect(c.size).toBeGreaterThan(1_000_000);
      expect(c.licence).toMatch(/MIT/);
    }
  });

  test('has every first-run component once, in install order', () => {
    expect(m.components.map((c) => c.id)).toEqual([
      'uv',
      'deno',
      'yt-dlp',
      'python-env',
      'ffmpeg',
      'chrome',
    ]);
  });

  test('yt-dlp is the official macOS binary checked against its published SHA2-256SUMS', () => {
    const y = m.components.find((c) => c.id === 'yt-dlp');
    expect(y).toMatchObject({
      kind: 'binary',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
      sumsUrl: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
      sumsName: 'yt-dlp_macos',
    });
  });
});

describe('validateManifest', () => {
  test('rejects bad shapes', () => {
    expect(() => validateManifest(null)).toThrow();
    expect(() => validateManifest({ schema: 'x', components: [] })).toThrow(/schema/);
    const ok = loadManifest();
    const bad = structuredClone(ok) as unknown as { components: Array<Record<string, unknown>> };
    bad.components[0]!['sha256'] = 'abc';
    expect(() => validateManifest(bad)).toThrow(/sha256/);
    const http = structuredClone(ok) as unknown as { components: Array<Record<string, unknown>> };
    http.components[0]!['url'] = 'http://example.com/uv.tar.gz';
    expect(() => validateManifest(http)).toThrow(/https/);
    const dup = structuredClone(ok) as unknown as { components: Array<Record<string, unknown>> };
    dup.components.push(dup.components[0]!);
    expect(() => validateManifest(dup)).toThrow(/duplicate/);
  });
});
