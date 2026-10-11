# Phase 07 — `vox` style v1 + GATE 3

| Field | Value |
|---|---|
| Status | waiting for GATE 3 (owner) |
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

## Reference looks (step 1)

`docs/evidence/phase-07/ref-frames/` (19 frames; reel 540 wide, TikTok 640 wide). Looks and the template each maps to:

| Frame | Look | Template |
|---|---|---|
| `reel-000.3s`, `reel-001.5s` | cutouts with a red outline on map paper, serif label on a yellow tag (top half; speaker below) | `paper-collage` |
| `reel-002.5s`, `reel-003.4s` | yellow land on a textured blue sea, red pins, black mono tags, dashed red route | `map-route` |
| `reel-004.4s`, `reel-005.2s`, `reel-006.4s` | white serif on black, word by word, last words larger, over a halftone portrait | `kinetic-serif` |
| `reel-007.5s` | "1952" bold serif + blueprint + framed photo + yellow tag | `year-card` (v1.1) |
| `reel-008.6s`, `reel-009.6s` | "2 billion cups. Every single day." serif on faded engraving paper, red underline, yellow mono tag | `stat` |
| `reel-009.6s` (bottom), `reel-011.5s` | newspaper clipping, gold frame + stamp | `newspaper`, `framed-portrait` (v1.1) |
| bottom half of `reel-000.3s` … `reel-006.4s`, `reel-013.5s` | mono uppercase captions on a dark rounded box, mid frame | `vox/mono-box` |
| `reel-020.0s`, `reel-030.0s` | screen recordings (not a style look) | — |
| `tt2-*` | second reference: white sans word captions low in frame, photo collage, cards | `vox/serif-lower` (placement), `paper-collage` |

The reel is a split screen (scene on top, speaker below); v1 scenes are full frame (split layout = v1.1 `stack`).

## Checklist
- [x] 0 references in place (owner allowed the download, see Pre-check)
- [x] 1 reference frames + looks (table above)
- [x] 2 tokens, fonts, texture: `style.json`; display font DM Serif Display after rendering both (`font-*.jpg`)
- [x] 3 `assets/motion.js` (pop `back.out(1.6)` on twos, seeded 2 px jitter on entrances, push-in), inlined + tested
- [x] 4 `kinetic-serif` · [x] 5 `stat` · [x] 6 `paper-collage` · [x] 7 `map-route` (each ended with validate green)
- [x] 8 transitions `paper-tear`, `slide-paper`; overlay `paper-grain`; presets `mono-box`, `serif-lower` (06 caption checks pass)
- [x] 8b kit check in validate (`sfx-kit`, `previews/sfx-sheet.png`; sine-beep style fails naming `notSynthesised`); kit reviewed; cues on every template and transition, timing measured (transitions too)
- [x] 9 vox in the token-scoping tests · [x] 10 mixed vox + base compiles (test) and renders (demo) · [x] 11 safe area on longest fixtures, no network (test + validate file refs + hook check)
- [~] 12 GATE 3 material ready; **waiting for the owner** (round 2: mixed emphasis, film-look, clipping + highlighter, archive grades, accent SFX)

## Files created / changed
- `styles/vox/`: `style.json`, `guide.md`, `assets/motion.js`, 4 templates (+ `map-route/build.mjs`), 2 transitions,
  `overlays/paper-grain.html`, `captions/{mono-box,serif-lower}.{html,json}`, `previews/*` (generated), SFX re-processed,
  `typewriter.wav` and Libre Caslon Display removed, `CREDITS.md`, `ASSETS.md`, `fonts/SOURCES.md`.
- `styles/base/captions/plain.html`: chunks inside the preset markup (render bug, D-46).
- `packages/engine/src/styles/{validate,cue-timing}.ts`, `src/api.ts`: kit check, transition cues, frame-0 window,
  opaque sample cutout, Python options for validate.
- Tests: `test/styles/vox/{motion,kit,style}.test.ts`, `test/compile/compile.test.ts` (vox scoping, mixed sequence),
  `test/styles/validate.test.ts` (window diffs, cue frames; static helper `kit: false`), `test/styles/wiring.test.ts`,
  `test/assets/early-assets.test.ts`, `packages/cli/test/projects.test.ts` (vox now the default style).
- `scripts/sync-vox-motion.mjs`, `scripts/vox-demo.ts`, `scripts/vox-side-by-side.sh`.
- Evidence `docs/evidence/phase-07/`: `side-by-side.jpg`, `demo-mono-box.mp4`, `demo-serif-lower.mp4` (720x1280
  copies; full renders are 150 MB and not committed), `qa.json`, `qa.png`, `LISTEN.md`, `sfx-sheet.png`,
  `vox-contact.jpg`, `font-*.jpg`, `ref-frames/`.

## Verify results
Other phases running at the same time (10b); CPU load high. No timing bar in this phase.

| Command | Result | Numbers |
|---|---|---|
| `vox style validate vox --json` | ok, 0 problems | 4 templates (13 fixtures) + 2 transitions rendered; cue-timing 15, safe-area 4, min-entrance 2, caption-states 2, caption-emphasis 2, caption-safe-area 4, caption-seek 2, sfx-kit 1, hook-determinism 1 |
| `pnpm -C packages/engine test -- styles/vox` | pass | 3 files, 22 tests |
| `vox audio-qa <demo> --json` | pass | cueTiming, oneEventPerCue, spacing, sfxUnderSpeech, loudness all pass; -13.97 LUFS, -1.5 dBTP |
| `vox audio-qa <demo> --kit vox --json` | pass | 5/5 files |
| `vox style validate base` | ok | after the `base/plain` fix |
| full fast suite (`npx vitest run`, under load) | 2275 passed, 6 failed, 1 skipped | then: 2 compile snapshots updated for the `base/plain` fix (diff = the caption layer only); `preview.test.ts`, `history/cursor.test.ts`, `log.test.ts` pass when rerun alone (timing under load); `stages/ytdlp.test.ts` fails on `npm_config_noproxy` from the pnpm env (unrelated) |

`qa.png` at the hero cue (2, `00:06.200`, `thump-tap` on the `stat` reveal): one short low transient in the SFX lane right
after a speech phrase ends; it does not show in the mix lane over speech (it sits 6+ LU under the voice). The other cues
are single short hits; cue 5 (`00:17.609`, `paper-tear` into the end card) is the longest event, one swell.

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | validate passes; 4 templates, 2 transitions, overlay, 2 presets render; presets pass word-state, emphasis, safe area | validate JSON above; overlay renders in `demo-*.mp4` (validate keeps overlays off) |
| 2 | mixed vox + base compiles and renders | `compile.test.ts` "a sequence mixing vox and base templates"; demo ends on `base/title` with `base`-inherited tokens |
| 3 | SFX kit passes the rules; cues pass timing; demo audio QA green | `sfx-kit` 1, cue-timing 15; `qa.json` pass |
| 4 | GATE 3 approved by the owner | **open** — waiting for the owner |
| 5 | sources and licences in R5, `ASSETS.md`, `CREDITS.md` | updated |

## Review findings (self-review (token budget); no subagents in this run)
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| self (code) | HIGH | caption chunks / bg classes outside the composition's scoped styles: a real render lost the caption box and font; `base/plain` too | yes (D-46) |
| self (code) | HIGH | validate's sample cutout was fully transparent, so no cutout template could be checked | yes |
| self (code) | MEDIUM | validate's DOM harness does not reproduce HyperFrames' style scoping, so the caption bug passed it | no: handoff |
| self (S9) | — | no network in any build: style files have no URLs or network APIs (test), hook static check passes, file refs are local | ok |
| self (visual) | MEDIUM | `serif-lower` is hard to read over bright footage even with the stronger shadow | open note for GATE 3 |

## GATE 3 — round 1 (2026-10-11)
Evidence: `side-by-side.jpg` (rows: collage + map, kinetic + stat, mono-box + serif-lower, and from the later
references word-reveal x2, inset card vs stat and framed inset vs collage; each pair is [reference | ours]), `demo-mono-box.mp4`, `demo-serif-lower.mp4`, `LISTEN.md`, `sfx-sheet.png`.
Recommendation: approve the four templates and `mono-box`; known gaps the owner may name: full-frame scenes vs the reel's
split screen (v1.1 `stack`), `serif-lower` legibility on bright footage, no typewriter sound, test faces and test
pattern as stand-in pictures (no archive photos in the demo). Not accepted on the owner's behalf.

## Later references (added by the owner before GATE 3, 2026-10-11)

Ten more videos (gitignored): the latest five of `@metro.media.house3` (one is `tiktok-2.mp4`) and of `@attentioncompound`.
Frames: `ref-frames/metro-*.jpg`, `ref-frames/att-*.jpg` (10 frames, 640 px).

- **Share with reel / tiktok-2**: fast cuts (a new picture every 1–3 s), archive and news footage as the picture,
  photos placed as framed insets with a shadow (`metro-3060-012.2s`, white card; `att-4270-009.9s`, a TV set), pinned
  photo collages and paper documents (metro strips), one bold title word now and then ("THE REAL WOLF", "$40", "They Said").
- **Add**: (1) captions with no box, one word at a time, small, centred near the subject; read words stay, emphasis
  words larger, often an italic serif (`att-6223-068.9s`, `att-4270-029.0s`); (2) darker, cinematic grading and black
  letterbox space around 16:9 footage in 9:16; (3) waveform and light-leak overlays (`att-2782-033.5s`).
- **Motion**: hard cuts, slow push-ins on photos, inset cards sliding in; little stop-motion (unlike the reel).
- **Sound**: a continuous music bed under the voice (integrated −21.3 and −20.0 LUFS on two files), dense broadband
  hits and whooshes at cuts (spectrogram). A music bed is the user's audio track, not a style asset; our SFX cover the hits.

**Iteration (one, bounded; D-47)**: new caption preset `vox/word-reveal` (box-free, word by word, emphasis in italic
display serif). `vox style validate vox`: ok, 0 problems (caption checks 3 presets). One run under load (load avg ~30)
failed `caption-seek` on the unchanged `vox/mono-box` (screenshot bytes differ); the rerun passed: a harness flake, not the
preset. `pnpm -C packages/engine test -- styles/vox`: 22 passed; styles + compile + assets: 302 passed. Demo with
`--preset vox/word-reveal`: audio QA pass, `LISTEN.md` timecodes unchanged. Evidence: `demo-word-reveal.mp4`, sheet rows 4–5.
Not done (open notes for the owner): darker grading, letterboxed 16:9 inserts, waveform overlay.

## GATE 3 — round 2 (2026-10-11, owner asked for more assets)

Self-review (token budget); no subagents in this run. Main merged into the branch first (no conflicts). Inputs:
`docs/research/2026-10-11-vox-asset-sourcing.md` (proposals 1–5, Freesound addendum), `asset-candidates/MANIFEST.json`
(rejected entries skipped), two reference sheets looked at (`attentioncompound-7690319707785776415`,
`attentioncompound-7683579797921877261`). Decision: D-48.

Done, smallest first (all five):
1. `vox/word-reveal`: words in Libre Caslon Text italic (new sibling file `LibreCaslonText-Italic.ttf`), emphasis in
   a bold grotesk (`Inter-ExtraBold-subset.woff2`, 12 kB, OFL, inlined as a data URL by `scripts/sync-vox-inline.mjs`;
   test `test/styles/vox/inline.test.ts`).
2. `overlays/film-look.html` (not default): Tri-X 400 grain scan (CC0, `assets/textures/grain-trix400.jpg`, 42 kB,
   inlined), seeded jump per held frame, 0–9 % exposure flicker, heavy vignette.
3. `paper-collage` 1.1.0: `clipping` (kicker, headline, body, `highlight` phrase with a yellow marker drawn on in
   0.5 s on held frames, torn bottom edge) — fixtures `clipping`, `longest` (max lengths, safe area ok).
4. `grade` on the collage cutouts: `bw`, `sepia`, `faded`, `vhs` (scanlines, RGB fringe) — fixtures `clipping`,
   `dark-single`, `longest`, `vhs`. Not done: grading the speaker or runtime footage (engine filter; backlog).
5. Kit 5 → 8: `snip` (Freesound 175522, preview), `type-key` (Freesound 380138, preview), `timpani` (Commons, CC0,
   peak -15.2 dBFS). Kit check rejected (`oneEvent`): Holga shutter, Freesound shutters 170229 and 431588, crumple
   151231, Commons scissors. Cues rewired (collage `snip`, kinetic `type-key`, stat `timpani`). Accent rule in
   `guide.md` "Sound"; the demo uses hard cuts and `sfxOff` so 2 of 5 cuts carry a sound. Freesound files are
   marked "preview-only, original needs Freesound login" in `assets/sfx/CREDITS.md`; owner TODO line added.

Verify (other phases' agents running; load avg 8–28):

| Command | Result |
|---|---|
| `vox style validate vox --json` | ok, 0 problems; 17 fixtures rendered, cue-timing 17, sfx-kit 1 (8 files), caption checks 3 presets. One run failed `caption-seek` on the unchanged `vox/mono-box` (known harness flake under load, round 1); reruns passed twice |
| demo audio QA (`mono-box`, `serif-lower`, `word-reveal` + `film-look`) | pass ×3. First run failed `sfxUnderSpeech` at 00:06.224 (timpani, margin -7.35 LU); fixed by 14 dB less gain on the file, never by a threshold |
| `pnpm lint`, `tsc --noEmit` | clean |
| full fast suite | 2291 passed, 1 failed (`stages/ytdlp.test.ts`, `npm_config_noproxy`, unrelated, as in round 1), 1 skipped |

Evidence (refreshed): `side-by-side.jpg` (6 rows; row 6 new: mixed emphasis on grainy black vs `word-reveal` +
`film-look`, web headline vs clipping), `demo-{mono-box,serif-lower,word-reveal}.mp4` (720x1280; word-reveal with
`film-look`), `qa.json`, `qa.png`, `LISTEN.md` (2 cues: `00:06.200` timpani hero, `00:14.012` type-key), `sfx-sheet.png`,
`vox-contact.jpg`, `ref-frames/att-7683-tile08.jpg`, `ref-frames/att-7690-tile03.jpg`.

Review (self): no HIGH open. MEDIUM: grade/film look do not reach the speaker footage (backlog); the highlighter is a
clean band, not a rough marker edge. LOW: `type-key` peaks at -1.2 dBFS (flagged as loud in `LISTEN.md` for the ear check).

Recommendation: approve, or name per-look changes. Not accepted on the owner's behalf. Round count: 2 of 3 (D-16).

## MANUAL STEPS
1. GATE 3 (required): see `plan/TODO.md`.
2. Required before release (does not block GATE 3): fetch the Freesound originals of `snip` and `type-key` (login), see `plan/TODO.md`.
3. Optional — does not block merge: record a typewriter key strike (licence `project`) for `typewriter` (appear).

## Handoff notes
- `vox` is the default style of new projects (engine `defaultId`); tests that assumed `base` were updated.
- Templates that create elements must append them inside their own markup (`.v-page`, `.c-layer`), never to
  `mount.root`: HyperFrames scopes composition styles; the validate DOM harness does not catch it.
- After editing `styles/vox/assets/motion.js`, run `node scripts/sync-vox-motion.mjs` then prettier.
- `vox style validate` now needs `uv` + the py project for the kit check (`kit: false` to skip).
- Phase 12: `guide.md` keyword rules map place → map-route, number → stat, list → paper-collage, punchline →
  kinetic-serif.
- Unrelated failures seen in the full suite: `packages/engine/test/stages/ytdlp.test.ts` (`npm_config_noproxy` from the
  pnpm environment), `*.local.test.ts` files (local only).

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
