# Phase 07 — `vox` style v1 + GATE 3

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-11 19:20 · |
| Model | Opus 5.5 · high (phase agent, parallel run with 10b; self-review (token budget)) |
| Machine | M5, macOS 27 |
| Branch | phase/07-vox-style |

## Pre-check
Prereqs 05 and 06 [x]. Step 0 done: the owner allowed the AI to download both style references (reference
only, gitignored): `reference/reel.mp4` (Instagram DePNgrmToh9, 1080x1920, 38 s) and `reference/tiktok-2.mp4`
(a second style reference the owner likes, 1280x720, 78 s). `docs/evidence/**/reference/` is gitignored as a
whole, so the extracted frames go to `docs/evidence/phase-07/ref-frames/` (committed, 19 frames).

## Plan summary
1. Reference looks (step 1): `ref-frames/` with the look per frame (table below).
2. `style.json` (spec Part B tokens), pick the display font by rendering both candidates.
3. `assets/motion.js`: pop (`back.out(1.6)`), hold on twos, seeded 2 px jitter, push-in. Templates cannot
   load a script by path in both preview and render builds (inlined vs `scenes/`), so each template inlines
   a copy between markers; `scripts/sync-motion.mjs` writes it and a test checks the copies equal the file.
4. Templates one by one, each ending with `vox style validate vox` green: kinetic-serif, stat,
   paper-collage, map-route (hook + vendored d3-geo).
5. Transitions paper-tear, slide-paper; overlay paper-grain; captions mono-box, serif-lower.
6. SFX: wire `audio-qa --kit` into validate (sine beep test style fails first), then judge the kit.
7. Checks: token scoping fixture, mixed vox + base sequence render, safe area, no network.
8. GATE 3 material: side-by-side sheet, 20 s demo, audio QA, LISTEN.md; stop for the owner.
Test order: motion sync test → validate per template → kit check failing test → token scoping + mixed render.

## Early steps (D-19) — a1-assets-geo

Package A1 (assets and geo). Branch `early/a1-assets-geo`, **merged to main** (merge commit 1e1f0a5, pushed;
worktree removed). Verify in the worktree before merge: `pnpm typecheck`, `eslint .`, `prettier --check .`,
`vitest run` all green (7 files, 73 tests; 11 of them geo, 25 asset), `uv run --project py pytest` 4 passed.

**Steps done**: part of 2 (fonts, texture), the geo data for 7, and the SFX sourcing half of 8b (candidates only).
No `style.json`, templates, `motion.js` or previews were created.

**Files** (all documented in `styles/vox/ASSETS.md`; hashes and licences in R5)
- `styles/vox/assets/fonts/`: Libre Caslon Display and DM Serif Display (both display candidates; step 2 picks one and
  deletes the other, with a DECISIONS entry), Libre Caslon Text (variable, body), IBM Plex Mono Regular + Bold (captions),
  five `OFL-*.txt`, `SOURCES.md`.
- `styles/vox/assets/geo/countries-50m.json`: `world-atlas@2.0.2` `countries-50m.json` (Natural Earth 1:50m Admin 0, NE 4.1.0,
  TopoJSON, objects `countries` (241, numeric ISO `id`, `properties.name`) and `land`; 739 kB; spherical, quantised).
- `styles/vox/assets/textures/paper.jpg`: CC0 "Papier aquarelle 100% coton, grain fin" (Wikimedia Commons, Les.aqua), 1024x1024
  crop, 190 kB. Warm grey watercolour-paper grain, not the `#EDE8DF` colour: tint or `multiply` it. Not seamless.
- `styles/vox/templates/map-route/vendor/`: `d3-geo.mjs` (d3-geo 3.1.1 + d3-array 3.2.4 + internmap 2.0.3 inlined),
  `topojson-client.mjs` (3.1.0), `LICENSES.md`. One file each, no imports, bundled with esbuild 0.25.10 (not minified).
  Test: Portugal from the countries file projects to an SVG path with `geoNaturalEarth1` + `geoPath` offline.
  Import from `build.mjs` as `./vendor/d3-geo.mjs` and `./vendor/topojson-client.mjs`.
- `styles/vox/assets/sfx/`: six candidate WAVs (mono, 48 kHz, 16-bit, 5 ms fades, peak -1.0 dBFS) and `CREDITS.md`
  (URL, author, licence, source hash, window, known weaknesses per file). All real Commons recordings: `paper-pop` (CC0 card
  flip), `paper-slide` (PD page turn), `whoosh` (PD page riffle), `stamp` (PD book drop), `typewriter` (CC0 typewriter bell),
  `thump-tap` (PD thud).

**Left for phase 07**
- **SFX acceptance is not decided.** The kit check (phase 05 `vox audio-qa --kit`) was not available. By eye, `whoosh` is a
  flat broadband bed, `typewriter` is a tonal bell, `thump-tap` is a pitched thud: these three will probably fail "not
  synthesised", "no steady noise bed" or "one onset" and must be replaced (Commons search found no free whoosh, stamp or
  typewriter key strike) or recorded for the project (licence `project`, D-16, optional MANUAL STEP). Never loosen a threshold.
- `licence` field: files from PDSounds are "Public domain" on Commons; the spec enum is `'CC0' | 'project'`. Write them as `CC0`
  (same dedication) or extend the enum; keep the true licence in `CREDITS.md`.
- Everything else in the phase: `style.json`, tokens, templates, motion.js, transitions, overlay, caption presets, guide, previews, GATE 3.
- Re-extracting the texture or sounds: see `ASSETS.md` and `CREDITS.md` (processing recipe: atrim, 5 ms fades, gain to -1 dBFS peak).
