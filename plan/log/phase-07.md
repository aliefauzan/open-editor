# Phase 07 — `vox` style v1 + GATE 3

Status: not started; early steps done under D-19

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
