// Copies styles/vox/assets/motion.js into every vox template, caption preset and overlay that has
// the `// vox:motion:begin` / `// vox:motion:end` markers. A composition cannot load a style script by
// path in both builds (preview inlines templates into index.html, render loads scenes/<id>.html), so
// the helpers are inlined; packages/engine/test/styles/vox/motion.test.ts checks the copies.
// Usage: node scripts/sync-vox-motion.mjs (then run prettier on the changed files).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'vox');
const motion = readFileSync(join(root, 'assets', 'motion.js'), 'utf8').trimEnd();
const BLOCK = /^([ \t]*)\/\/ vox:motion:begin\n(?:[\s\S]*?\n)?[ \t]*\/\/ vox:motion:end$/m;

export function motionFiles(styleDir = root) {
  const out = [];
  const tdir = join(styleDir, 'templates');
  if (existsSync(tdir)) {
    for (const t of readdirSync(tdir).sort()) {
      const f = join(tdir, t, 'template.html');
      if (existsSync(f)) out.push(f);
    }
  }
  for (const sub of ['captions', 'overlays']) {
    const d = join(styleDir, sub);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d).sort()) if (n.endsWith('.html')) out.push(join(d, n));
  }
  return out.filter((f) => BLOCK.test(readFileSync(f, 'utf8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of motionFiles()) {
    const src = readFileSync(f, 'utf8');
    const next = src.replace(BLOCK, (_m, pad) => {
      const body = motion
        .split('\n')
        .map((l) => (l === '' ? '' : pad + l))
        .join('\n');
      return `${pad}// vox:motion:begin\n${body}\n${pad}// vox:motion:end`;
    });
    if (next !== src) {
      writeFileSync(f, next);
      console.log(`updated ${f}`);
    }
  }
}
