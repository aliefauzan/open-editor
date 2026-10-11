import { defineConfig } from '@playwright/test';

// Playwright for Electron (R5 pin 1.64.0, D-16). `pnpm -C apps/desktop e2e -- smoke` builds first.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
});
