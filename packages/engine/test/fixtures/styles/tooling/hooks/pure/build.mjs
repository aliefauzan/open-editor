// Pure hook: a vendored helper by relative path, a node builtin that is not a network module, and the
// seed. Comments may name Date.now() or fetch() without failing the check.
import { posix } from 'node:path';
import { scale } from './vendor/lib.mjs';

export function build(vars, ctx) {
  return {
    vars: { ...vars, size: scale(3), seed: ctx.seed, file: posix.basename('a/b.svg') },
    files: { 'shape.svg': `<svg data-seed="${ctx.seed}"></svg>` },
  };
}
