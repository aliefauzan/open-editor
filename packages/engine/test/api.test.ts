import { describe, expect, test } from 'vitest';
import { version } from '../src/api.ts';

describe('engine api', () => {
  test('exports the package version as a semver string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
