export function build(vars) {
  return { vars: { ...vars, at: Date.now(), r: Math.random(), t: performance.now() } };
}
