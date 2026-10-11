import { describe, expect, test } from 'vitest';
import { compareVersions, parseVersion } from '../../src/engine-host/setup/version.ts';

describe('versions', () => {
  test('parses an optional v prefix and rejects junk', () => {
    expect(parseVersion('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseVersion('1.2.3-beta.2')?.pre).toEqual(['beta', 2]);
    expect(parseVersion('1.2.3+build5')?.patch).toBe(3);
    for (const bad of ['', '1.2', 'latest', '1.2.x', '01.2.3', '1.2.3.4']) {
      expect(parseVersion(bad)).toBeUndefined();
    }
  });

  test('orders by semver precedence', () => {
    const order = [
      '0.9.9',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0',
      '1.0.1',
      '1.10.0',
      '2.0.0',
    ];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(Math.sign(compareVersions(order[i]!, order[j]!))).toBe(Math.sign(i - j));
      }
    }
    expect(compareVersions('v1.2.3', '1.2.3+x')).toBe(0);
  });

  test('throws on an unparsable version', () => {
    expect(() => compareVersions('nope', '1.0.0')).toThrow();
  });
});
