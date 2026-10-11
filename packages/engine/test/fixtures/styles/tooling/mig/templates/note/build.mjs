// Test hook: version 2 renamed `text` to `label`; `migrate` maps 1.x variables.
export function migrate(vars, fromVersion) {
  if (fromVersion.startsWith('1.')) {
    const { text, ...rest } = vars;
    return { ...rest, label: text === 'bad' ? 42 : text };
  }
  return vars;
}

export function build(vars) {
  return { vars };
}
