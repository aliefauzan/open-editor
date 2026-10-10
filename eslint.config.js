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

const EXT = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
// relative paths that climb into a sibling package folder
const rel = (names, message) => ({ regex: `^(\\.\\./)+(${names})(/|$)`, message });

const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

const CP = '^(node:)?child_process$';
const noShell = [
  'error',
  {
    selector: `ImportDeclaration[source.value=/${CP}/] > ImportSpecifier[imported.name=/^exec(Sync)?$/]`,
    message: 'S26: use spawn/execFile with an argument array, never exec/execSync',
  },
  {
    selector: `ImportDeclaration[source.value=/${CP}/] > :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)`,
    message:
      'S26: import named functions (spawn, execFile) from child_process; no default or namespace import',
  },
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=/${CP}/]`,
    message: 'S26: do not require child_process; use a named ESM import of spawn/execFile',
  },
  {
    selector: `ImportExpression[source.value=/${CP}/]`,
    message:
      'S26: do not dynamically import child_process; use a named ESM import of spawn/execFile',
  },
  {
    selector:
      'MemberExpression[property.name=/^exec(Sync)?$/][object.name=/^(cp|child_process|childProcess)$/]',
    message: 'S26: use spawn/execFile with an argument array, never exec/execSync',
  },
  {
    selector: "CallExpression[callee.property.name='execSync']",
    message: 'S26: use spawn/execFile with an argument array, never execSync',
  },
  {
    selector:
      "Property[key.name='shell']:not([value.value=false]), Property[key.value='shell']:not([value.value=false])",
    message: 'S26: never spawn with a shell (only shell: false is allowed)',
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
    files: [`packages/engine/**/*.${EXT}`],
    rules: restrict(
      NO_AGENT,
      NO_CLI,
      NO_DESKTOP,
      rel('agent|cli|apps', 'engine never reaches into other packages (R1)'),
    ),
  },
  {
    files: [`packages/agent/**/*.${EXT}`],
    rules: restrict(
      ENGINE_API_ONLY,
      NO_CLI,
      NO_DESKTOP,
      rel('engine|cli|apps', 'agent imports @vox/engine only (R1)'),
    ),
  },
  {
    files: [`packages/cli/**/*.${EXT}`],
    rules: restrict(
      ENGINE_API_ONLY,
      NO_DESKTOP,
      rel('engine|agent|apps', 'cli imports @vox/engine and @vox/agent by package name (R1)'),
    ),
  },
  {
    files: [`apps/desktop/src/main/**/*.${EXT}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // a bare '@vox/engine' is a path rule; the negation only works in a group of its own
          paths: [{ name: '@vox/engine', message: 'main may import only @vox/engine/paths' }],
          patterns: [
            group(['@vox/agent', '@vox/agent/*'], 'main process never imports the agent'),
            group(
              ['@vox/engine/*', '!@vox/engine/paths'],
              'main may import only @vox/engine/paths',
            ),
          ],
        },
      ],
    },
  },
  {
    files: [`apps/desktop/src/renderer/**/*.${EXT}`],
    rules: restrict(
      group([...nodeBuiltins, 'node:*'], 'renderer never imports Node modules'),
      group(
        ['@vox/engine', '@vox/engine/*', '@vox/agent', '@vox/agent/*'],
        'renderer never imports engine or agent',
      ),
    ),
  },
);
