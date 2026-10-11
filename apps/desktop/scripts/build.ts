// Builds the app with vite 8 (R5 pin; electron-vite 5 accepts vite ≤ 7 only, D-36):
//   out/renderer   React UI (served by vox-app://), plus the vendored HyperFrames player
//   out/preload    the window.vox bridge (CommonJS, sandboxed preload)
//   out/main       Electron main (CommonJS: Playwright's Electron launcher needs a CJS main)
//   out/engine-host  bundled engine host, packaged builds only (`--package`); dev runs src/ (TS)
//   out-resources/   packaged builds only: the app's Resources (scripts/stage-resources.ts) and
//                    the bundled `vox` CLI (out-resources/cli/vox.mjs)
// Usage: node scripts/build.ts [--package [--no-apple]]  (--no-apple: no Apple helper; D-16)
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { build, type InlineConfig } from 'vite';
import { STAGE, stageResources } from './stage-resources.ts';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'out');
const SRC = path.join(ROOT, 'src');
const pkg = process.argv.includes('--package');
const NODE_EXTERNALS = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

const base: InlineConfig = { configFile: false, logLevel: 'warn', mode: 'production' };

async function renderer(): Promise<void> {
  await build({
    ...base,
    root: path.join(SRC, 'renderer'),
    base: './',
    plugins: [tailwindcss()],
    oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
    build: { outDir: path.join(OUT, 'renderer'), emptyOutDir: true, target: 'chrome152' },
  });
  const player = path.join(
    path.dirname(createRequire(import.meta.url).resolve('@hyperframes/player')),
    'hyperframes-player.global.js',
  );
  mkdirSync(path.join(OUT, 'renderer', 'vendor'), { recursive: true });
  copyFileSync(player, path.join(OUT, 'renderer', 'vendor', 'hyperframes-player.js'));
}

async function preload(): Promise<void> {
  await build({
    ...base,
    build: {
      outDir: path.join(OUT, 'preload'),
      emptyOutDir: true,
      target: 'chrome152',
      minify: false,
      lib: {
        entry: path.join(SRC, 'preload', 'index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      rollupOptions: { external: ['electron'] },
    },
  });
}

async function nodeBundle(
  entry: string,
  outDir: string,
  format: 'cjs' | 'es',
  file: string,
  emptyOutDir = true,
) {
  await build({
    ...base,
    ssr: { noExternal: true, external: NODE_EXTERNALS },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir,
      target: 'node24',
      minify: false,
      rollupOptions: { external: NODE_EXTERNALS, output: { format, entryFileNames: file } },
    },
  });
}

rmSync(OUT, { recursive: true, force: true });
await renderer();
await preload();
await nodeBundle(path.join(SRC, 'main', 'index.ts'), path.join(OUT, 'main'), 'cjs', 'index.cjs');
if (pkg) {
  await nodeBundle(
    path.join(SRC, 'engine-host', 'index.ts'),
    path.join(OUT, 'engine-host'),
    'es',
    'index.mjs',
  );
  await stageResources({ appleHelper: !process.argv.includes('--no-apple') });
  await nodeBundle(
    path.join(SRC, 'cli', 'vox.ts'),
    path.join(STAGE, 'cli'),
    'es',
    'vox.mjs',
    false,
  );
  // Electron 44 has no postinstall: its binary downloads on first use. electron-builder packs
  // node_modules/electron/dist (electronDist), so a fresh clone fetches it here (D-16 fresh clone).
  const electronExe = createRequire(import.meta.url)('electron') as string;
  if (!existsSync(electronExe)) throw new Error(`no Electron binary at ${electronExe}`);
}
process.stdout.write(
  `built ${path.relative(process.cwd(), OUT) || OUT}${pkg ? ' (package)' : ''}\n`,
);
