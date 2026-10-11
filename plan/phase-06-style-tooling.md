# Phase 06 — Style tooling (Part A rest)

| Field | Value |
|---|---|
| Track | styles |
| Prereq | 03 (may run in parallel with 04/05) |
| Spec § | styles "Part A" (template rules incl. `minEntranceMs`, caption presets, versions/migration, compile hook trust, style registry CLI), "Testing" (schema, template, hooks, caption presets, `minEntranceMs`) |
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
  check, contact sheet `previews/contact.jpg`, per-template thumbnail + GIF in `previews/`; for styles with
  `sfx`: a `CREDITS.md` entry per file, and the cue-timing check for every fixture with `sfxCues`
  (per-frame pixel difference on the fixture render; styles spec "Testing", D-14). The SFX kit rules
  join `validate` in 07, once 05's `audio-qa --kit` exists (06 may run before 05).
  D-15 checks: `minEntranceMs` (a positive integer when set; a variables schema that declares the
  reserved `skipEntrance` fails); every caption preset has `captions/<preset>.json` that passes the
  preset schema (`case`, `stripPunctuation`, `safeArea`, `position`); each preset renders a sample
  `CaptionChunk[]` into the contact sheet and passes the caption preset checks (word states,
  emphasis, safe area, `case`/`stripPunctuation`; styles spec "Testing").
- `vox style new <styleId> [--extends vox]`: scaffold (rejects built-in ids and existing ids).
- `vox style trust <styleId>`: records trust for a user style outside its folder after a confirmation prompt; the registry reads it through `isTrusted(styleId, dir)` (a user style's own `trusted` field is ignored, D-23).
- `engine.styles.accept(id)`, `remove(id)` (non-built-in only).
- `TEMPLATE_VERSION` migration through `migrate(variables, fromVersion)` from trusted `build.mjs`.
- `styles/base/previews/` generated.

## Steps

1. [x] `vox style new` rejects built-in and existing ids; template identity through a chain
       (`vox/map-route` inherited stays `vox/map-route`). (`extends`, cycle and collision tests are owned
       by phase 03.)
2. [x] `TEMPLATE_VERSION` migration: with `migrate` in a trusted hook, variables migrate across a major;
       in an untrusted style it fails with `HOOK_UNTRUSTED` (the plain major-mismatch test is owned by 03).
3. [x] Hook purity by determinism: run each hook twice with the same `ctx.seed` and compare the output
       bytes; a static check rejects `Date`, `Math.random`, `performance.now`, `process.hrtime`, `fetch` and
       `node:http(s)`/`node:net` imports in hook source. Hooks load as normal ES modules but must be
       self-contained: libraries are vendored ESM inside the style folder and imported by relative path; a
       bare import (e.g. `d3-geo`) or a path leaving the style folder fails `validate` (styles spec "Compile
       hook", D-10), so hooks work in the packaged app without `node_modules`. Trust (S8) is the security
       boundary, not a sandbox.
4. [x] Safe-area check: render longest-text fixture, read text bounding boxes via the composition DOM,
       assert inside 1080×1920 safe area.
5. [x] `validate` on `base` passes and writes previews; `new` + `trust` + `remove` round trip.
5b. [x] `minEntranceMs` in `validate` (D-15): a fixture template with `minEntranceMs: 2000` rendered at 1500 ms
       shows its resting state at frame 0 (every element the entrance animates has its final opacity and
       transform, read from the DOM); rendered at 3000 ms, frame 0 differs from the 1500 ms frame 0; a
       variables schema declaring `skipEntrance` fails `validate` with the rule named.
5c. [x] Caption presets in `validate` (D-15): a preset with no `.json` or a bad `case` fails; the
       contact sheet holds one frame per preset from the fixture `CaptionChunk[]` (two lines, one emphasis
       word, a 200 ms gap) at a frame inside word 2, so the active-word state shows; the word-state,
       emphasis and safe-area checks (03 step 9c) run for every preset of the style, also with
       `position.yPct` 95; `base/plain` passes.
6. [x] Cue timing and credits in `validate` (D-14): a missing `CREDITS.md` entry fails; a fixture whose
       `appear` cue is 4 frames off the measured pop (per-frame pixel difference) fails; a correct test
       style passes.

## Verify

```bash
pnpm -C packages/engine test -- styles
pnpm -C packages/cli exec vox style validate base --json
```

## Done when

- [ ] `vox style validate base` passes and writes `styles/base/previews/contact.jpg`.
- [ ] S8 `migrate` part passes (untrusted `migrate` never runs).
- [ ] Styles spec "Testing" schema/template/hook bullets covered, plus the cue-timing, caption-preset and
      `minEntranceMs` bullets (D-15; the SFX kit bullet is closed in 07).
- [ ] R2: style format and caption preset format marked frozen.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Cue-timing measurement noisy on grain overlays | Measure with overlays off and a fixed seed; the rule only checks cue types it can measure |
| Bounding boxes hard to read from the rendered DOM | Use HyperFrames' snapshot/DOM hook at a frame; else a headless Chrome page that mounts the composition at the fixture's last frame |

## Handoff notes

- Phase 07 uses `vox style validate vox` as its quality gate, incl. the caption preset checks for
  `vox/mono-box` and `vox/serif-lower` (D-15).
- Phase 15 uses `new`-style scaffolding for extracted styles (`status: draft`, `trusted: false`).
