# Phase 14a — `vox` v1.1 templates + GATE 6

| Field | Value |
|---|---|
| Status | GATE 6 reopened by the owner (D-67); round 3 sheet waits for the owner (D-71) |
| Started · Finished | 2026-10-12 · 2026-10-12 |
| Model | Sonnet 5.5 · high (phase agent, parallel run with 14b–14g and 15; self-review (token budget)) |
| Machine | M5, macOS 27 |
| Branch | phase/14a-vox-templates |

## Pre-check
Prereq 13 merged on main (D-60). Engine already compiles `template` slots into nested panels (phase 03,
`kit/stack` test fixture), so `vox/stack` needed no engine change. References: `docs/evidence/phase-07/ref-frames/`
(the reel's three-panel split screen: `reel-007.5s` year card + stat + framed portrait, `reel-008.6s`, `reel-009.6s`).

## Plan summary
1. One template at a time, each with 3 or more fixtures (one `longest`), cue chosen so `vox style validate vox` measures it.
2. `year-card` (dark board, self-drawing blueprint, tilted framed photo, tag), `framed-portrait` (gold / polaroid / none,
   iris, zoom, stamp, thud), `newspaper` (aged clipping, language-aware hyphenation), `stack` (nested panels in bands).
3. `guide.md` rules, `style.json` 1.1.0, tests (8 scenes, stack fixtures name installed templates, one non-hero cue each).
4. GATE 6: `scripts/vox-side-by-side-v11.sh`, review against the reel, fix, record. Test order: style.test.ts → validate.

## Checklist
- [x] 1 `year-card` · [x] 2 `framed-portrait` · [x] 3 `newspaper` · [x] 4 `stack` (each ended with validate green)
- [x] 5 cues measured (`cue-timing` 30 checks: every fixture of the 8 templates)
- [x] 6 `guide.md` rules for the four, sound paragraph; style version 1.1.0
- [x] 7 tests updated/added (`styles/vox/style.test.ts`: 16 tests)
- [x] 8 GATE 6 sheet, 2 rounds, passed by owner delegation (see below)

## Files created / changed
- `styles/vox/templates/{year-card,framed-portrait,newspaper,stack}/` (template.json, template.html, fixtures: 3, 4, 3, 3)
- `styles/vox/{style.json,guide.md}`, `styles/vox/previews/{year-card,framed-portrait,newspaper,stack}.{jpg,gif}`, `contact.{jpg,json}`
- `packages/engine/src/styles/validate.ts` (contact sheet JPEG quality 6), `packages/engine/test/styles/vox/style.test.ts`
- `scripts/vox-side-by-side-v11.sh`; evidence `docs/evidence/phase-14a/side-by-side.jpg` (final), `side-by-side-round1.jpg`
- Spec: styles "Templates" v1.1 table (variables), D-65.

## Verify results
Other phases ran at the same time (load high; full suite 2 min 12 s).

| Command | Result | Numbers |
|---|---|---|
| `vox style validate vox --json` | ok, 0 problems, 0 notes | `fixtures` 10 (8 scenes + 2 transitions; 13 fixture files for the 4 new scenes), `cue-timing` 30, `safe-area` 8, `min-entrance` 5, `blank-frame` 30, `sfx-kit` 1 |
| `vox audio-qa --kit vox` | not run as written: the command needs a project; the kit check is part of validate (`sfx-kit` 1, pass) and no sound file changed | |
| `pnpm lint` | pass | eslint + prettier |
| full suite (`vitest run`) | 2487 passed, 5 failed, 1 skipped | the 5 failures are `*.local.test.ts` that call the real Apple on-device model: `com.apple.SensitiveContentAnalysisML Code=15` from the helper on this machine, unrelated to styles (apple-helper, apple, apple-fast) |

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | `vox style validate vox` passes for all 8, cue timing included | validate JSON above |
| 2 | side-by-side sheet for the 4 new ones approved (GATE 6) | by owner delegation, below |

## GATE 6 (by owner delegation, D-49 / D-58; the AI reviewed the sheet itself, no human eye)
Sheet: `docs/evidence/phase-14a/side-by-side.jpg`: 2 rows of 2 pairs [reel crop | ours]: year-card vs the top panel of
`reel-007.5s`, framed-portrait vs the bottom panel of `reel-008.6s`, newspaper vs the bottom panel of `reel-009.6s`, stack
vs the whole `reel-007.5s` split screen. Stand-in pictures (the test pattern) replace archive photos.
- Round 1 (`side-by-side-round1.jpg`), critical findings: `framed-portrait` tag shifted off screen (the entrance's
  transform replaced `translateX(-50%)`); frame cropped at the bottom inside a `stack` band; `newspaper` brown like
  cardboard, landscape, on a dark board while the reel's is a light board; blueprint white, thin and mostly hidden;
  tilted card covered the year; stack cues peaked later than pinned (nested entrances move too).
- Fixes: tag centred with `xPercent`; frame 56 % x 38 % so it fits the band; clipping paler, portrait (aspect 1 / 1.08), paper
  board by default; blueprint warm tan, full-height grid, bigger drawing; card moved down; `stack` cue to `appear`; the
  framed-portrait land cue measured and moved to 2000 ms; vignette on dark boards; stamp inside the safe area.
- Round 2: validate green; sheet reviewed against the reel: layout, type, colours, stamp and tag placement match
  (year top-left over a framed photo; tag under; gold frame with tag above and stamp on its corner; clipping on a light
  board with masthead rule, 2-line headline, photo, text columns; three stacked panels with a paper rim). Passes.
- Open notes (backlog, none blocks): archive photos instead of the test pattern; rococo frame carving; 3-panel `stack` is
  narrower than the reel's panels (9:16 scenes in landscape bands); hero cue for a stamp-only beat; `newspaper` has no
  torn edge; `framed-portrait` iris and `year-card` blueprint draw are visible in motion only (previews `*.gif`).

## GATE 6 round 3 (D-67 reopened the gate; D-71; the owner decides)
Branch `phase/14a-gate6-r3`, worktree `.worktrees/phase-14a-r3`. Model Opus 5.5 · self-review (token budget). The
AI did not pass this gate: the sheet is for the owner.

Sheet: `docs/evidence/phase-14a/side-by-side-r3.jpg` (2293x1440, `scripts/vox-side-by-side-v11.sh`; the round 2
sheet `side-by-side.jpg` is kept). Left: 4 rows of [reel 16:9 band | our `stack` band | our full 9:16 still]:
year-card (reel 8.6 s top), framed-portrait (reel 7.5 s bottom), framed-portrait gone (reel 8.6 s bottom), newspaper
(reel 9.6 s bottom). Right: the whole reel frame beside our whole `stack` at 9.6 s and 8.6 s. Full 9:16 stills per
template: `docs/evidence/phase-14a/r3/*.jpg`. Stills come from `scripts/vox-gate6-r3.ts`, which uses real public-domain
pictures in `docs/evidence/phase-14a/r3-inputs/` (see `SOURCES.md` there) as per-project media.

What changed:
- Engine: optional `panelAspect` in `template.json` (allowed only with a template slot). `stack` sets `"16:9"`, so each
  panel renders at the canvas width and a 16:9 height (1080x608 in 1080x1920) and panel templates switch to their
  landscape layout (`W/H >= 1.2`). Tests: compile (`panelSize`, stack panel size) and schema (3 reject, 1 accept).
- `stack` 1.1.0: three full-width bands (about 89 % wide, 960x540 like the reel) with thin dark gaps on a near-black
  board; no paper rims.
- `year-card` 1.1.0: charcoal board (`board-dark.jpg`), big cream serif year with a light stroke, the `blueprint`
  image as a white line drawing with dimension lines and arrowheads, a tilted b/w photo in a cream border, yellow tag.
- `framed-portrait` 1.1.0: a real carved gilt frame (`frame-rococo.webp`, MET 460353, CC0) with the tag above, a slow
  camera push, new optional `empty` (the painting slides out and leaves an empty wall before the stamp), red stamp
  worn by an SVG turbulence filter. Iris only for `polaroid` / `none`. Cue unchanged (land at 2000 ms).
- `newspaper` 1.1.0: a small drawn aged front page on a light mottled board (`board-light.jpg`), ragged edge,
  condensed headline (`Anton-subset.woff2` as `Vox Condensed`), italic subhead, three filler columns, engraved photo.
  Slide 80 % over 0.5 s (cue-timing). No Gallica scan is used or shipped.
- Landscape modes (portrait unchanged): `stat` (sizes from H, inset faded print on the light board),
  `kinetic-serif` and `paper-collage` (sizes from `min(W, H)`), so they read inside a band.
- Previews: the GIF palette uses a Bayer dither (`bayer_scale=5`) so `styles/vox/previews/` stays under the 8 MB test
  bound (7,581,548 B).
- Assets (records in `styles/vox/ASSETS.md` and `assets/fonts/SOURCES.md`, tests in `early-assets.test.ts`):
  `props/frame-rococo.webp` (CC0, MET), `textures/board-dark.jpg` and `board-light.jpg` (CC0, ambientCG Concrete036),
  `fonts/Anton-subset.woff2` + `OFL-Anton.txt` (OFL 1.1). `scripts/sync-vox-inline.mjs` knows `.webp`.

Iterations (scratch sheets, not committed):
- A: `stat` overflowed a landscape band; year too small; frame too small and stamp hard to see; flat boards. Fixed
  with landscape sizes, a bigger frame and push, a stamp at 15 % of the frame height, the textured boards.
- B: the camera push moved the tag out of the band; portrait layouts collided (year vs tag). Fixed the push origin and
  the portrait positions (year and tag at 12.5 % for the safe area).
- C: line drawing too strong, gilt too dark, stamp too orange, coffee print too busy. Lowered the drawing opacity,
  brightened the gilt, stamp #d2352a, faded inset print.

Remaining differences (honest list):
- The Comet photo is parked on the ground, not in flight (the in-flight copy on Commons was a look reference only).
- The line drawing is a Comet 4 outline with livery lines (BOAC letters stay), not the reel's Comet 1 with hatching.
- The year serif (DM Serif Display) is lighter than the reel's heavy serif.
- The MET frame's carving differs (no cherubs) and it is stretched to a 0.75 aspect.
- The gone state is fully empty; the reel's 8.6 s still is caught mid-wipe.
- The stamp font is DM Serif, not a slab serif; at panel scale the stamp reads fainter than the reel's.
- The newspaper uses filler text and a plain masthead rule; its paper is slightly more tan.
- The `stat` panel has no cutouts (the reel's 7.5 s middle band) and no "CUTOUT STYLE" caption (captions are separate).
- `kinetic-serif` text sits high in a landscape band.
- Motion is checked through stills, previews and validate only, not by a human watching.

Verify (round 3): `vox style validate vox --json` ok, 0 problems, 0 notes (schema 1, fixtures 10, cue-timing 30,
safe-area 8, min-entrance 6, blank-frame 30, sfx-kit 1, file-refs 15). Suite, typecheck and lint: see the commit
(full-suite numbers in the handoff report). The impeccable hook flags `broken-image` (empty `src`, set at runtime) and
`dark-glow` (the clipping's inset edge burn): intentional, as in round 2.

Status: GATE 6 and row 14a stay open in `plan/PROGRESS.md`; the owner judges `side-by-side-r3.jpg`.

## Review findings (self-review (token budget); no subagents in this run)
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| self (code) | HIGH | `framed-portrait` tag lost its centring when the entrance tween set `transform` | yes |
| self (code) | MEDIUM | `stack` panels were cropped by the band (frame bottom, stamp) | yes |
| self (S9) | - | no network use: validate `file-refs` + `no file names a network URL` test pass | ok |
| self (visual) | LOW | impeccable hook: inset sepia shadows on the clipping and empty `src` on template images (set at runtime) | intentional, left as is |

## MANUAL STEPS
None required. Optional: look at `previews/*.gif` of the four templates at full size.

## Handoff notes
- `vox/stack` panels: any scene template of the style except `vox/stack`. Since round 3 (D-71) each panel renders as
  a whole 16:9 scene (`panelAspect`, 1080x608 in 1080x1920), not a crop of a 9:16 scene. `year-card`,
  `framed-portrait`, `newspaper`, `stat`, `kinetic-serif` and `paper-collage` size themselves for a band;
  `map-route` in a band was not checked in round 3.
- `framed-portrait` stamp: the sound cue is the frame thud at 2000 ms; set `sfxOff` only to silence it.
- A scene template whose `durationMs.min` equals its `minEntranceMs` cannot be checked by validate ("cannot be checked" note).
- Full-suite Apple on-device tests fail on this machine (SensitiveContentAnalysis); not related.
