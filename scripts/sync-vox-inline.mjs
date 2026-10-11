// Inlines small binary assets of the vox style (a font subset, a grain tile) as data URLs into the
// compositions that use them. Compositions cannot load a style file by path in both builds (see
// sync-vox-motion.mjs) and the token contract only carries the paper texture, so a CSS line that
// follows a `/* vox:inline <style-relative path> */` comment gets `url("data:<mime>;base64,...")` of
// that file. packages/engine/test/styles/vox/inline.test.ts checks the copies.
// Usage: node scripts/sync-vox-inline.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'vox');
const MIME = { '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png' };
// group 1: the marker path; group 2: everything up to the data URL on the next line
export const INLINE = /\/\* vox:inline (\S+) \*\/(\n[^\n]*?url\(')data:[^']*'/g;

export function dataUrl(rel, styleDir = root) {
  const mime = MIME[extname(rel)];
  if (!mime) throw new Error(`no MIME type for ${rel}`);
  return `data:${mime};base64,${readFileSync(join(styleDir, rel)).toString('base64')}`;
}

export function inlineFiles(styleDir = root) {
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
  return out.filter((f) => readFileSync(f, 'utf8').includes('/* vox:inline '));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of inlineFiles()) {
    const src = readFileSync(f, 'utf8');
    const next = src.replace(
      INLINE,
      (_m, rel, head) => `/* vox:inline ${rel} */${head}${dataUrl(rel)}'`,
    );
    if (next !== src) {
      writeFileSync(f, next);
      console.log(`updated ${f}`);
    }
  }
}
