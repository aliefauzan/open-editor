import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });

async function messages(filePath: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`);
}

describe('eslint boundaries (R1) and process rules (S26)', () => {
  test('engine may not import @vox/agent', async () => {
    const m = await messages('packages/engine/src/x.ts', "import '@vox/agent';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('engine may not import @vox/cli', async () => {
    const m = await messages('packages/engine/src/x.ts', "import '@vox/cli';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('agent may not import @vox/cli', async () => {
    const m = await messages('packages/agent/src/x.ts', "import '@vox/cli';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('agent may not reach into engine internals', async () => {
    const m = await messages('packages/agent/src/x.ts', "import '@vox/engine/src/model/x.ts';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('cli may import engine and agent', async () => {
    const m = await messages(
      'packages/cli/src/x.ts',
      "import '@vox/engine';\nimport '@vox/agent';\n",
    );
    expect(m).toEqual([]);
  });
  test('nothing in packages imports apps/desktop', async () => {
    const m = await messages('packages/cli/src/x.ts', "import '@vox/desktop';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('renderer may not import node modules', async () => {
    const m = await messages(
      'apps/desktop/src/renderer/x.ts',
      "import fs from 'node:fs';\nvoid fs;\n",
    );
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('child_process exec is forbidden', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import { exec } from 'node:child_process';\nexec('ls');\n",
    );
    expect(m.join('\n')).toMatch(/no-restricted-imports|no-restricted-syntax/);
  });
  test('execSync call through a namespace is forbidden', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import * as cp from 'node:child_process';\ncp.execSync('ls');\n",
    );
    expect(m.join('\n')).toMatch(/no-restricted-syntax/);
  });
  test('shell: true is forbidden', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import { spawn } from 'node:child_process';\nspawn('ls', [], { shell: true });\n",
    );
    expect(m.join('\n')).toMatch(/no-restricted-syntax/);
  });
  test('spawn and execFile with an argument array are allowed', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import { spawn, execFile } from 'node:child_process';\nspawn('ls', ['-l']);\nexecFile('ls', ['-l'], () => {});\n",
    );
    expect(m).toEqual([]);
  });
  test('require of child_process is forbidden', async () => {
    const m = await messages(
      'packages/engine/src/x.cjs',
      "const { exec } = require('node:child_process');\nexec('ls');\n",
    );
    expect(m.join('\n')).toMatch(/S26/);
  });
  test('dynamic import of child_process is forbidden', async () => {
    const m = await messages('packages/engine/src/x.ts', "await import('node:child_process');\n");
    expect(m.join('\n')).toMatch(/S26/);
  });
  test('aliased exec import is forbidden', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import { exec as run } from 'child_process';\nrun('ls');\n",
    );
    expect(m.join('\n')).toMatch(/S26/);
  });
  test('default import of child_process is forbidden', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import cp from 'node:child_process';\ncp.spawn('ls');\n",
    );
    expect(m.join('\n')).toMatch(/S26/);
  });
  test('shell option other than false is forbidden', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import { spawnSync } from 'node:child_process';\nspawnSync('ls', [], { shell: '/bin/sh' });\n",
    );
    expect(m.join('\n')).toMatch(/S26/);
  });
  test('shell: false is allowed', async () => {
    const m = await messages(
      'packages/engine/src/x.ts',
      "import { spawnSync } from 'node:child_process';\nspawnSync('ls', [], { shell: false });\n",
    );
    expect(m).toEqual([]);
  });
  test('relative import from engine into agent is forbidden', async () => {
    const m = await messages('packages/engine/src/x.ts', "import '../../agent/src/api.ts';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('relative import from agent into engine is forbidden', async () => {
    const m = await messages('packages/agent/src/x.ts', "import '../../engine/src/api.ts';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('boundaries also apply to .mts files', async () => {
    const m = await messages('packages/engine/src/x.mts', "import '@vox/agent';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('main may import @vox/engine/paths but not other engine subpaths', async () => {
    const ok = await messages('apps/desktop/src/main/x.ts', "import '@vox/engine/paths';\n");
    expect(ok).toEqual([]);
    const bad = await messages(
      'apps/desktop/src/main/x.ts',
      "import '@vox/engine/src/model/x.ts';\n",
    );
    expect(bad.join('\n')).toMatch(/no-restricted-imports/);
  });
  test('renderer may not import node: only modules', async () => {
    const m = await messages('apps/desktop/src/renderer/x.ts', "import 'node:sqlite';\n");
    expect(m.join('\n')).toMatch(/no-restricted-imports/);
  });
});
