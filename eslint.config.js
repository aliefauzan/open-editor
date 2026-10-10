import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

// R1 import boundaries, enforced per package. S26: no shell spawning.
const group = (names, message) => ({ group: names, message });
const NO_DESKTOP = group(['@vox/desktop', '@vox/desktop/*'], 'packages never import apps/*');
const NO_CLI = group(['@vox/cli', '@vox/cli/*'], 'only the app and users import the cli');
const NO_AGENT = group(['@vox/agent', '@vox/agent/*'], 'engine never imports agent (R1)');
const ENGINE_API_ONLY = group(
  ['@vox/engine/*'],
  'import @vox/engine only (src/api.ts exports); @vox/engine/paths is for apps/desktop/src/main',
);
const nodeBuiltins = [...builtinModules.flatMap((m) => [m, `node:${m}`]), 'electron'];

const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

const noShell = [
  'error',
  {
    selector:
      'ImportDeclaration[source.value=/^(node:)?child_process$/] > ImportSpecifier[imported.name=/^exec(Sync)?$/]',
    message: 'S26: use spawn/execFile with an argument array, never exec/execSync',
  },
  {
    selector: "CallExpression[callee.property.name='execSync']",
    message: 'S26: use spawn/execFile with an argument array, never execSync',
  },
  {
    selector:
      "CallExpression[callee.object.name=/^(cp|child_process|childProcess)$/][callee.property.name='exec']",
    message: 'S26: use spawn/execFile with an argument array, never exec',
  },
  {
    selector: "Property[key.name='shell'][value.value=true]",
    message: 'S26: never spawn with shell: true',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/build/**',
      '**/dist/**',
      '.worktrees/**',
      'py/**',
      'docs/**',
      'plan/**',
      'styles/**/vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-syntax': noShell,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/engine/**/*.{ts,js}'],
    rules: restrict(NO_AGENT, NO_CLI, NO_DESKTOP),
  },
  {
    files: ['packages/agent/**/*.{ts,js}'],
    rules: restrict(ENGINE_API_ONLY, NO_CLI, NO_DESKTOP),
  },
  {
    files: ['packages/cli/**/*.{ts,js}'],
    rules: restrict(ENGINE_API_ONLY, NO_DESKTOP),
  },
  {
    files: ['apps/desktop/src/main/**/*.{ts,tsx}'],
    rules: restrict(
      group(['@vox/agent', '@vox/agent/*'], 'main process never imports the agent'),
      group(['@vox/engine'], 'main may import only @vox/engine/paths'),
    ),
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: restrict(
      group(nodeBuiltins, 'renderer never imports Node modules'),
      group(
        ['@vox/engine', '@vox/engine/*', '@vox/agent', '@vox/agent/*'],
        'renderer never imports engine or agent',
      ),
    ),
  },
);
