# Test styles (registry fixtures)

Test-only styles for `packages/engine/test/styles/` (phase 03 steps 1 and 2, early package E5, D-19).
They are not the real `base` or `vox` styles. Font, texture and sound files here are text placeholders:
the registry only checks that they exist inside the style folder.

- `builtin/base`: complete root style (trusted, built-in).
- `builtin/paper`: trusted built-in child of `base` with a hook template (`paper/map`).
- `user/draft`: untrusted draft child of `paper` with its own hook template (`draft/card`).
- `user/base`: a user style that reuses the built-in id `base` (rejected as a duplicate).
