import { spawnFileSync } from './spawn.ts';
import { describe, expect, test } from 'vitest';

describe('vox cli', () => {
  test('--version prints "vox <version>"', () => {
    const out = spawnFileSync(['--version']);
    expect(out.trim()).toMatch(/^vox \d+\.\d+\.\d+/);
  });
});
