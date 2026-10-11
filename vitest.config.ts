import { defineConfig } from 'vitest/config';

// Test tiers (R3, D-16): fast = default, slow = *.slow.test.ts (VOX_SLOW=1), local = *.local.test.ts (never on CI).
const slow = process.env['VOX_SLOW'] === '1';

export default defineConfig({
  test: {
    include: slow
      ? [
          'packages/*/test/**/*.slow.test.ts',
          'apps/*/test/**/*.slow.test.ts',
          'test/**/*.slow.test.ts',
          'spike/test/**/*.slow.test.ts',
        ]
      : [
          'packages/*/test/**/*.test.ts',
          'apps/*/test/**/*.test.ts',
          'test/**/*.test.ts',
          'spike/test/**/*.test.ts',
        ],
    exclude: slow
      ? ['**/node_modules/**']
      : [
          '**/node_modules/**',
          '**/*.slow.test.ts',
          ...(process.env['CI'] ? ['**/*.local.test.ts'] : []),
        ],
    testTimeout: slow ? 600_000 : 30_000,
  },
});
