import { x } from '../../escape.mjs';
export function build(vars) {
  return { vars: { ...vars, x } };
}
