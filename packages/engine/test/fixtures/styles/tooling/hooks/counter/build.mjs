// No banned API, but state kept between calls: the second run differs.
let calls = 0;
export function build(vars) {
  calls += 1;
  return { vars: { ...vars, calls } };
}
