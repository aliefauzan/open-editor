// Test hook: reads a style asset, uses ctx.seed, imports a vendored helper, writes a file.
import { shout } from './vendor/helper.mjs';

export function build(vars, ctx) {
  const csv = ctx.readAsset('assets/data/places.csv').toString('utf8').trim();
  return {
    vars: { ...vars, title: shout(vars.title), seed: ctx.seed, data: ctx.fileUrl('route.txt') },
    files: { 'route.txt': `${csv}\nseed=${ctx.seed}\n` },
  };
}
