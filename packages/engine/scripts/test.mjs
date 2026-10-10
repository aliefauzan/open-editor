// Runs the root vitest config on this package only. Extra positional args are file filters
// relative to packages/engine/test (e.g. `pnpm -C packages/engine test -- --run history/recovery`).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(pkg, '../..');
const args = process.argv.slice(2).filter((a) => a !== '--' && a !== '--run');
const flags = args.filter((a) => a.startsWith('-'));
const filters = args.filter((a) => !a.startsWith('-')).map((f) => `packages/engine/test/${f}`);
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
const r = spawnSync(
  process.execPath,
  [vitest, 'run', ...flags, ...(filters.length ? filters : ['packages/engine/'])],
  { cwd: root, stdio: 'inherit' },
);
process.exitCode = r.status ?? 1;
