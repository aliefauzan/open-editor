export async function build(vars) {
  const m = await import('./' + vars.name);
  return { vars: { ...vars, m } };
}
