# Phase 06 — Style tooling (Part A rest)

| Field | Value |
|---|---|
| Track | styles |
| Prereq | 03 (may run in parallel with 04/05) |
| Spec § | styles "Part A" (template rules, versions/migration, compile hook trust, style registry CLI), "Testing" (schema, template, hooks) |
| Model | Sonnet 5.5 · medium |
| Gate | — (style format freezes at the end) |
| Next | 07 |

## Goal

Style authors (us in phase 07, users later) have the tools the spec promises: validate a style end to
end, scaffold a new one, trust it for hooks, migrate template variables across major versions, and
generate previews.

## Required reading

- Styles spec "Part A" in full and "Testing"; engine "Compile" (hooks, `TEMPLATE_VERSION`).
- `plan/ref/R4-security.md` row S8.

## Output

- `vox style validate <styleId>`: schema check, lint every template (`lint --json`), render every fixture
  (`render --strict-all`, draft), safe-area bounding-box check for the longest text fixture, missing-asset
  check, contact sheet `previews/contact.jpg`, per-template thumbnail + GIF in `previews/`.
- `vox style new <styleId> [--extends vox]`: scaffold (rejects built-in ids and existing ids).
- `vox style trust <styleId>`: sets `trusted: true` for a user style after a confirmation prompt.
- `engine.styles.accept(id)`, `remove(id)` (non-built-in only).
- `TEMPLATE_VERSION` migration through `migrate(variables, fromVersion)` from trusted `build.mjs`.
- `styles/base/previews/` generated.

## Steps

1. [ ] `vox style new` rejects built-in and existing ids; template identity through a chain
       (`vox/map-route` inherited stays `vox/map-route`). (`extends`, cycle and collision tests are owned
       by phase 03.)
2. [ ] `TEMPLATE_VERSION` migration: with `migrate` in a trusted hook, variables migrate across a major;
       in an untrusted style it fails with `HOOK_UNTRUSTED` (the plain major-mismatch test is owned by 03).
3. [ ] Hook purity by determinism: run each hook twice with the same `ctx.seed` and compare the output
       bytes; a static check rejects `Date`, `Math.random`, `performance.now`, `process.hrtime`, `fetch` and
       `node:http(s)`/`node:net` imports in hook source. Hooks load as normal ES modules but must be
       self-contained: libraries are vendored ESM inside the style folder and imported by relative path; a
       bare import (e.g. `d3-geo`) or a path leaving the style folder fails `validate` (styles spec "Compile
       hook", D-10), so hooks work in the packaged app without `node_modules`. Trust (S8) is the security
       boundary, not a sandbox.
4. [ ] Safe-area check: render longest-text fixture, read text bounding boxes via the composition DOM,
       assert inside 1080×1920 safe area.
5. [ ] `validate` on `base` passes and writes previews; `new` + `trust` + `remove` round trip.

## Verify

```bash
pnpm -C packages/engine test -- styles
pnpm -C packages/cli exec vox style validate base --json
```

## Done when

- [ ] `vox style validate base` passes and writes `styles/base/previews/contact.jpg`.
- [ ] S8 `migrate` part passes (untrusted `migrate` never runs).
- [ ] Styles spec "Testing" schema/template/hook bullets covered.
- [ ] R2: style format marked frozen.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Bounding boxes hard to read from the rendered DOM | Use HyperFrames' snapshot/DOM hook at a frame; else a headless Chrome page that mounts the composition at the fixture's last frame |

## Handoff notes

- Phase 07 uses `vox style validate vox` as its quality gate.
- Phase 15 uses `new`-style scaffolding for extracted styles (`status: draft`, `trusted: false`).
