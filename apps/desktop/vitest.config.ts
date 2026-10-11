import { defineConfig } from 'vitest/config';

// Same tiers as the root config (R3, D-16): fast by default, *.slow.test.ts with VOX_SLOW=1.
const slow = process.env['VOX_SLOW'] === '1';

export default defineConfig({
  test: {
    include: slow ? ['test/**/*.slow.test.ts'] : ['test/**/*.test.{ts,tsx}'],
    exclude: slow ? ['**/node_modules/**'] : ['**/node_modules/**', '**/*.slow.test.ts'],
    testTimeout: slow ? 600_000 : 30_000,
    hookTimeout: slow ? 600_000 : 30_000,
    fileParallelism: !slow,
  },
});
