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
});
