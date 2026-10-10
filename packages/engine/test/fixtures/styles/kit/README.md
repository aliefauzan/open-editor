# Compile test styles

Test-only styles for `packages/engine/test/compile/` (phase 03). Not real styles.

- `kit`: child of the real `base`. `kit/stack` mounts 2–3 panels (nested `template` slots, depth 1);
  `kit/card` has an image slot and a compile hook (`build.mjs`) that reads a style asset, uses
  `ctx.seed`, imports a vendored helper by relative path and writes a file; `kit/swatch` is a
  minimal panel. Tests make `kit` trusted through `isTrusted`.
- `kitdraft`: untrusted child of `kit` whose own template `kitdraft/note` has a hook (must never run).
