# Phase 14a — `vox` v1.1 templates + GATE 6

| Field | Value |
|---|---|
| Status | done (GATE 6 approved by owner delegation, D-65) |
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
- `vox/stack` panels: any scene template of the style except `vox/stack`; each panel shows the upper half of its scene,
  so panels whose content sits lower (`paper-collage` items below 50 %, `map-route` labels) get cropped.
- `framed-portrait` stamp: the sound cue is the frame thud at 2000 ms; set `sfxOff` only to silence it.
- A scene template whose `durationMs.min` equals its `minEntranceMs` cannot be checked by validate ("cannot be checked" note).
- Full-suite Apple on-device tests fail on this machine (SensitiveContentAnalysis); not related.
