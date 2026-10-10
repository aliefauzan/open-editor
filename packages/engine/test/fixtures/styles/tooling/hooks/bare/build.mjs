import { geoPath } from 'd3-geo';
export function build(vars) {
  return { vars: { ...vars, p: typeof geoPath } };
}
