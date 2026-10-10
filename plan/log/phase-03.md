# Phase 03 — Engine: styles loader, `base` style, compile, captions, audio

| Field | Value |
|---|---|
| Status | done |
| Started · Finished | 2026-10-11 03:20 · 2026-10-11 04:35 |
| Model | Opus 5.5 · high (single agent; owner asked to cut token cost) |
| Machine | M5, macOS 27 |
| Branch | phase/03-engine-styles-compile-audio |

## Pre-check
01 [x] (GATE 1 all pass, D-29: whole-sequence HyperFrames render, no hybrid, NTSC go, no pre-render cache),
02 [x] (contracts frozen, D-28). Early steps E5 (styles schema/registry/tokens, D-23) and A1 (fonts, geo) merged.
Tools: node 24.14, ffmpeg 8.1.2, HyperFrames 0.8.145, GSAP 3.15.0 (R5).

## Plan summary
- A. Wire the E5 registry: `TemplateLookup` from the registry (02's ops), `engine.styles.list/get`,
  `vox new` picks `vox` when installed, else `base`. Token scoping in compile. `styles/base` content
  (templates `title`, `text-overlay`, `placeholder`, transitions `crossfade`, `dip-to-black`, preset
  `base/plain`, A1 fonts, fixtures, `guide.md`).
- B. `model/captions.ts`: `deriveCaptions` (pure) on 02's `mapWordsToTimeline`, SRT/VTT, `engine.captions`,
  `SequenceView.captions`.
- C. `compile/`: in-memory `BuildResult` + `writeBuild`, ported from `spike/lib/compile.ts` and the spike
  templates (`vox-runtime.js`, `vox-preview.js` helpers per D-29), hooks (S8), framing transforms, CFR
  copies, captions mount, preview audio, SFX audio, fonts, vendored runtime + GSAP; S9 check.
- D. `audio/`: cue list (`cues.ts`), ffmpeg graph + two-pass loudnorm + stems; `render/layers.ts` (MOV
  with alpha). Hybrid export: not needed (GATE 1 go, D-29), step 15 n/a.
- E. `engine.geo.search` over A1's `src/geo/search.ts`.
- Test order: registry/lookup → base style → captions → compile snapshots → hooks/S8/S9 → contract
  (slow: lint + render) → 90 s fixture (slow) → cues → audio graph (+ slow renders) → layers (slow) → geo.
- Step 7 review: self-review (owner asked to cut token cost; no review agents).


## Checklist
- [x] 1–3 Schemas, registry, token CSS (early E5, D-23); token scoping in compile: the sequence style's tokens when
  its chain includes the declaring style, else the declaring style's (`test/compile/compile.test.ts` scoping).
- [x] 4 Scene variables through the real registry (`styles/lookup.ts` `registryTemplateLookup`; engine default;
  `test/styles/wiring.test.ts`); `vox new` picks `vox` when installed, else `base`.
- [x] 5 `styles/base`: `title`, `text-overlay`, `placeholder`, `crossfade`, `dip-to-black`, `base/plain`, fixtures
  (≥ 2 per scene, a `longest`), `guide.md`; fixtures validate (`base-templates.test.ts`), lint 0 errors and render
  non-blank back to back over video with both transitions (`base-templates.slow.test.ts`).
- [x] 6, 6b `deriveCaptions` + D-15 lines/gap fill/emphasis (`test/model/captions.test.ts`); `engine.captions`,
  `SequenceView.captions`.
- [x] 7 Snapshots render + preview (`__snapshots__/main.{render,preview}.txt`), byte-identical on rerun.
- [x] 8 Hooks: `ctx.readAsset` (rejects `..`/absolute), `ctx.seed`, vendored import, deterministic; S8
  (untrusted own hook → `HOOK_UNTRUSTED`; trusted parent's template through an untrusted child runs).
- [x] 8b `NO_HANDLES` with the real `base/crossfade` (`handles.test.ts`).
- [x] 9 Layer order, hidden/muted tracks, `MEDIA_MISSING`, `TEMPLATE_VERSION`, CFR copy, framing transforms.
- [x] 9b `skipEntrance`, preset `case`/`stripPunctuation`, nested `stack` panels.
- [x] 9c `base/plain` in Chrome (`caption-preset.slow.test.ts`): word 2 active (700) with 1/3 read/unread (400,
  pixel-identical), backward seek byte-identical, emphasis 1.2x in every state, word boxes inside the safe area at
  yPct 75 and 95. Found and fixed: the emphasis word's box crossed the safe area by 4 px (line height 1.25 → 1.35).
- [x] 10 S9: no `http(s)` in generated build files.
- [x] 11 Contract (pinned 0.8.145): render + preview lint 0 errors; 3 s render 90 frames, non-blank.
- [x] 12 Spike 90 s fixture through the engine (`spike90.slow.test.ts`, spike bench `checkCuts`): 2700 frames,
  2145 frames checked, 43 cuts, 0 mismatches, 0 cut errors, 0 flat, min margin 115. Found and fixed: crossfade
  half (250 ms = 7.5 frames) put the incoming clip off the grid, one source frame late for 38 frames.
- [x] 13 Audio graph (`audio/graph.ts`), snapshot (`__snapshots__/graph.txt`); slow: click onsets ≤ 1 frame,
  youtube/tiktok/broadcast ±1 LU with true peak ≤ −1 dBTP, stems sum to the pre-loudnorm mix (< 1e-4), silence.
- [x] 13b Per-source gain (target − integratedLufs), `afftdn` light/strong, off adds nothing; two sources 10 LU
  apart mix within 1 LU.
- [x] 13c Cue list (`audio/cues.ts`, `cues.test.ts`).
- [x] 14 `renderLayers`: compile `layers` option + `render/layers.ts` → ProRes 4444 `yuva*` MOV, alpha partly
  transparent (`render/layers.slow.test.ts`).
- [—] 15 n/a (GATE 1: whole-sequence render, no hybrid, D-29).
- [x] 16 `engine.geo.search("lisbon")` (A1 search wired; empty query → `VALIDATION`).

## Files created / changed
- `packages/engine/src/`: `compile/{compile,fonts,hooks,write}.ts`, `compile/runtime/{vox-runtime,vox-preview}.js`,
  `audio/{cues,graph}.ts`, `render/layers.ts`, `styles/lookup.ts`, `model/captions.ts`; changed `api.ts`
  (compile, writeBuild, captions, styles, geo, mix, renderLayers), `errors.ts` (MEDIA_MISSING, TEMPLATE_VERSION,
  HOOK_UNTRUSTED), `model/fps.ts` (`blendHalf`), `ops/scenes.ts` (NO_HANDLES in whole frames).
- `styles/base/**` (style.json, 5 templates + fixtures, `captions/plain.*`, guide.md; A1 fonts).
- Tests: `test/compile/*` (fixture, hf helpers, compile, handles, layers, contract/caption-preset/spike90 slow),
  `test/audio/*`, `test/styles/{wiring,base-templates}*`, `test/render/layers.slow.test.ts`, `test/model/*`;
  test styles `test/fixtures/styles/kit/` (kit, kitdraft). `packages/cli` (`vox new` style).

## Verify results
| Command | Result | Numbers |
|---|---|---|
| `pnpm -C packages/engine test` | green | 79 files, 1119 passed |
| `pnpm -C packages/engine test:slow -- compile/contract compile/caption-preset compile/spike90 styles/base-templates audio/mix render/layers` | green | 6 files, 19 passed, 69 s (bench lock) |
| `pnpm typecheck` | green | |
| `pnpm lint` (eslint + prettier) | green | |

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | Compile snapshots, contract, audio (presets, per-source gain, denoise, stems), cue list pass | `test/compile/*`, `test/audio/*` |
| 2 | `deriveCaptions` lines/gap fill/emphasis; `base/plain` passes 9c | `test/model/captions.test.ts`, `caption-preset.slow.test.ts` |
| 3 | `NO_HANDLES` against the real `base` registry | `test/compile/handles.test.ts` |
| 4 | Engine-compiled 90 s spike fixture renders with correct cuts | `spike90.slow.test.ts` (numbers above) |
| 5 | `base` templates lint and render their fixtures | `base-templates.slow.test.ts` |
| 6 | S8 and S9 tests pass | `compile.test.ts` hooks + S9 |

## Review findings
Self-review (owner asked to cut token cost; no review agents). Phase diff read against R4 S8/S9 and the specs.
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| self | HIGH | crossfade overlap off the frame grid (source one frame late) | yes, `blendHalf` (D-30) |
| self | HIGH | `base/plain` emphasis word box past the caption safe area | yes, line height 1.35 |
| self | MEDIUM | a silent mix (no audible source) failed in loudnorm pass 2 (`-inf`) | yes, loudnorm skipped; slow test |
| self | LOW | `engine.renderLayers` compiles again instead of sharing `compile` (same code path) | no, cosmetic |
| self | LOW | template rule "longest fixture text box inside the safe area" is not yet a per-template test for `base` | no, phase 06 (`vox style validate`) |
No secrets, personal paths or owner email in the diff (grep).

## Deviations
- D-30 (compile/audio/layers implementation choices, below in DECISIONS).

## MANUAL STEPS
None.

## Handoff notes
- 05 (render/export): `engine.mix(projectId, seqId, { out, preset, stemsDir?, range? })` writes the final WAV
  (pcm_f32le 48 kHz stereo, two-pass loudnorm); mux it with the silent HyperFrames render. Range: compile's
  `applyRange` is exported and used by `mix`. `engine.renderLayers(projectId, seqId, layers, { out })` writes
  `build/<seq>-layers/` and a ProRes 4444 MOV; layer ids are scene item ids, `<itemId>-tx`, `overlay-<name>`,
  `captions`. A/V sync of the 90 s fixture is yours (the picture side passes here).
- 05: CSS `url()` rebasing in render scene files (`../styles/...`) is not covered by a render (base has no
  texture); the `vox` style (07) will be the first to exercise it.
- 05/07: `hyperframes lint` scans only `index.html`; render-mode scene files are not linted. Lint scene files
  separately if needed (e.g. a one-scene index).
- 10a: preview build vendor list adds `hyperframe.runtime.iife.js` and `vox-preview.js`; templates register with
  `window.__timelines[mount.key] = mount.register(tl)` (lint-visible); `vox.mount` returns `key`.
- 04: framing `facetrack`/`auto` take keyframes from `CompileInput.framing` (`FramingProvider`); phase 05 plugs
  the real path builder in.
- 06: `vox style validate` should own the longest-fixture text-box test; kit test styles are in
  `packages/engine/test/fixtures/styles/kit/`.
- Spike reuse: `spike90.slow.test.ts` and `audio/mix.slow.test.ts` import `spike/bench` and `spike/lib`
  (cut and click analysis). Keep those modules if `spike/` is ever trimmed.
- Fixtures for `spike90` come from `packages/engine/test/fixtures/out` (or `VOX_FIXTURES`); the test skips when absent.

## Early steps (D-19) — a1-assets-geo

Package A1 (assets and geo). Branch `early/a1-assets-geo`, **merged to main** (merge commit 1e1f0a5, pushed;
worktree removed). Verify in the worktree before merge: `pnpm typecheck`, `eslint .`, `prettier --check .`,
`vitest run` all green (7 files, 73 tests; 11 of them geo, 25 asset), `uv run --project py pytest` 4 passed.

**Steps done**: 5 (only the font files for `styles/base`), 16 (geo search, data and index; engine wiring left).

**Files**
- `styles/base/assets/fonts/`: `Inter-Variable.ttf` (display, body; variable opsz/wght), `IBMPlexMono-Regular.ttf`,
  `IBMPlexMono-Bold.ttf` (captions), `OFL-Inter.txt`, `OFL-IBMPlexMono.txt`, `SOURCES.md` (upstream path + SHA-256 per file;
  Google Fonts repo commit `bd8f81ddb5c7`). Files are byte-identical to upstream (TTF kept so OFL reserved names
  are not an issue); only the variable font's brackets were dropped from its name.
- `packages/engine/data/places.json` (518 kB, format `vox-places/1`, 7342 Natural Earth 5.1.2 populated places,
  columns `name, aliases, country, iso2, admin1, lat, lon, population, capital`), `build-places.mjs` (rebuild from the
  Natural Earth .dbf, deterministic), `NOTICE.md` (source URL, zip SHA-256, licence).
- `packages/engine/src/geo/search.ts`: pure, imports only `node:fs` (no `errors.ts`, no `api.ts`; a test asserts it).
  Exports `normalise`, `createPlaceIndex(file)`, `searchPlaces(index, query, { limit })`, `search(query, opts)` (default
  lazy index over `data/places.json`), types `Place`, `PlacesFile`. Query rules: case, diacritics and punctuation
  ignored; exact name > prefix > word prefix; primary name beats alias (Natural Earth `namepar`/`namealt`/`nameascii`,
  e.g. `bombay` -> Mumbai, `lisboa` -> Lisbon); bigger population and capitals rank first; `"portland, us"` or
  `"lisbon, portugal"` narrows by country, ISO code or admin1 prefix; default limit 10. Returns `Place`
  `{ name, country, iso2, admin1, lat, lon, population, capital }` (a `geo` slot stores only `{ name, lat, lon }`).
- Tests: `packages/engine/test/geo/search.test.ts` (11, includes `lisbon` offline), `packages/engine/test/assets/early-assets.test.ts`.
- Root `.prettierignore` gained `packages/engine/data/`, `styles/**/vendor/`, `styles/**/assets/geo/`.
- R1 got the `src/geo/` row and the `data/` description (R1 is plan/**).

**Left for phase 03**
- `engine.geo.search(query)` in `api.ts` (wrap `search` from `src/geo/search.ts`; map an empty or invalid query to the
  engine's own error handling), the agent's `search_places` tool is phase 11.
- Step 16's wording says "index built at install from bundled data": the index is built in memory at first use
  from the bundled `places.json` (about 10 ms for 7342 rows); no install-time step is needed.
- `styles/base/style.json` `fonts` entries (`family`, `file`, `weight`), `@font-face` copying, templates, fixtures, `guide.md`.
  Inter is a variable font: declare `font-weight: 100 900` for it in `@font-face`.

**Handoff**
- Natural Earth data is public domain; no attribution required. IBM Plex Mono OFL has reserved name "Plex": do not rename or subset the files.
- Format of fonts is TTF (no woff2 conversion; see SOURCES.md).

## Early steps (D-19) — e5-style-format

Package E5 (style format: schema, registry, tokens). Branch `early/e5-style-format` (commits 0fd46b9, 6fbe0f6),
shim swapped to `src/errors.ts` after 02 (codes STYLE_NOT_FOUND, STYLE_INVALID, STYLE_DUPLICATE); **merged to main as
bcaa07a**, worktree removed (post-merge verify: pnpm test 1378 passed / 1 skipped, pytest 109 passed). Decision: D-23. Verify in the worktree: `pnpm typecheck`, `pnpm lint`
(eslint + prettier) green; `pnpm test` 10 files, 213 tests (styles 3 files, 140); `uv run --project py pytest` 4 passed.
Reviewed twice (typescript-reviewer); fixes in 6fbe0f6 (self-declared trust, Ajv `$id` cache, `url()` in token
values, realpath containment on every read).

**Steps done**: 1 (format: `style.json`, `template.json`, caption preset `.json` from D-15, `sfx` from D-14,
`minEntranceMs`, variables schema checked with ajv), 2 (registry: search order, duplicates, `extends` chain,
merge, template identity `<styleId>/<name>`, S8 trust from the declaring style), the token-name part of 3
(`--tok-<group>-<name>`, sorted, byte-stable CSS).

**Files**
- `packages/engine/src/styles/schema.ts`, `registry.ts`, `tokens.ts`; `packages/engine/src/errors.pending.ts` (shim,
  byte-identical to the orchestrator copy).
- `packages/engine/package.json` dependencies `zod 4.6.5`, `ajv 8.20.0` (same pins as 02; exports/scripts unchanged),
  `pnpm-lock.yaml`.
- Tests `packages/engine/test/styles/{schema,registry,tokens}.test.ts`; test styles in
  `packages/engine/test/fixtures/styles/` (`builtin/base`, `builtin/paper`, `user/draft`, duplicate `user/base`).
  No `styles/**` content (A1 owns it).
- New error codes (append to `ERROR_CODES` at the shim swap): `STYLE_NOT_FOUND`, `STYLE_INVALID`, `STYLE_DUPLICATE`.

**Left for phase 03**
- Shim swap after 02 merges: `errors.pending.ts` imports to `../errors.ts`, codes appended to `ERROR_CODES`.
- Token scoping inside compile (GATE 1 item 7); compile passes `assetUrl` built from `files.texture.paper`
  (the real path) to `tokensCss`.
- Step 4: `registry.template()` behind 02's template lookup in ops; `vox new` picks the style; `engine.styles`
  in `api.ts` (`list`, `get`; `accept`/`remove` are 06).
- The real `styles/base/style.json` (with A1's fonts), templates, fixtures and `guide.md`.
- Optional: swap the local path-string checks in `schema.ts` for `paths.ts` helpers.

**Left for phase 06**: trust store behind the registry's `isTrusted(styleId, dir)` (`vox style trust`), the
`maxLength` rule for text variables in `vox style validate`.
