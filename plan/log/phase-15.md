# Phase 15 — Styles Part C: style from a reference video

| Field | Value |
|---|---|
| Status | done (GATE 8 passed by owner delegation, D-70; not a blind human A/B) |
| Started · Finished | 2026-10-12 · 2026-10-12 |
| Model | Opus 5.5 · high (phase agent, no subagents; self-review (token budget)) |
| Machine | M5, macOS 27 |
| Branch | phase/15-style-extract (worktree `.worktrees/phase-15`) |

## Pre-check
Prerequisite 13 merged on main (ee82856, D-60; checked by the orchestrator). Phases 14a–14g run at the
same time in other worktrees (CPU load during timings). Owner delegation (D-49, D-58): GATE 8 and the
step 6 MANUAL STEP are done by the AI and recorded as such; GATE 8 is not a blind human A/B. No
credentials: the live vision model is local Ollama. No `drawtext` in the Homebrew ffmpeg (D-17).

## Plan summary
1. Fixture `style-extract-10s.mp4` (+ `.truth.json`) in `make.sh`: 1080x1920, 4 flat-colour shots
   (cuts 2000/4500/7000 ms), 3 upper-case 3-word captions burnt in from checked-in caption cards (PNG,
   no `drawtext`, D-17).
2. Python measure tools: `vox_py/ocr.py` (Apple Vision OCR at 4 fps → captions: words, position, case)
   and `vox_py/palette.py` (k-means k = 8), JSON Schemas in `py/tests/schemas/`, pytest.
3. Engine `styles/extract/`: `measureReference` (shots + facetrack jobs, keyframes, contact sheets,
   palette, OCR → measurements), font catalogue (`data/fonts/`, ~40 OFL fonts with tags), `mapDraftStyle`
   (deterministic), `writeDraftStyle` (`~/.vox/styles/<id>/`, extracted/draft/untrusted), report.html.
4. Agent: job kind `style.extract` (`registerStyleExtract`), describe with the `vision` model (mocked in
   tests), tool `extract_style`, workflow `style-extract.md`; CLI `vox style extract` and
   `vox agent --workflow style-extract`.
5. App: `styles.extract` IPC, gallery flow (report in a sandboxed `vox-media://` frame, Accept/Discard,
   limits text), agent panel quick action; E2E with the mocked model.
6. Real reference run with Ollama (step 6, by delegation), A/B script, GATE 8 judged by measurement.

Test order: make.sh fixture test → pytest ocr/palette → engine measure (fixture) → map with fixed JSON →
S8 extract-untrusted-hook → report CSP (protocol test) → agent style-extract → E2E style-gallery.

## Checklist
- [x] 1 fixture + measurement tests (d39ba47; shots 4, palette within tolerance, captions 3 words / upper / 75 %)
- [x] 2 describe + map (mocked model; deterministic `style.json`; plain-JSON fallback; near-miss repair)
- [x] 3 validate draft (re-skin renders every inherited template (vox + base) incl. `vox/map-route` with its trusted hook) + S8 test
- [x] 4 report via `vox-media://` with the untrusted-HTML CSP (protocol test; sandboxed frame, CSP_APP `frame-src vox-media:`)
- [x] 5 gallery E2E (`e2e/style-gallery.spec.ts`, 2 tests) + renderer test (`test/renderer/style-extract.test.tsx`)
- [x] 6 real reference + real vision model (by owner delegation: Ollama `qwen3.5:latest`)
- [x] 7 A/B script + GATE 8 (by owner delegation; judged by measurement and frames, not a blind human A/B)

## Files created / changed
- Fixture and Python: `packages/engine/test/fixtures/make.sh` (`style-extract-10s.mp4`, caption cards),
  `py/vox_py/ocr.py`, `py/vox_py/palette.py`, schemas and pytest.
- Engine: `packages/engine/src/styles/extract/` (`measure.ts`, `catalogue.ts`, `description.ts` with
  `repairDescription`, `map.ts`, `write.ts`), `styles/manage.ts` (`newStyleRoot`), `styles/validate.ts`
  (re-skin rendering; inherited cue timing as a note), `resources.ts` (data/py folders by path),
  `data/fonts/` (50 OFL TTFs, licences, `catalogue.json`, `SOURCES.md`), NOTICE.md.
- Agent: `packages/agent/src/styleExtract.ts`, `tools/jobs.ts` (`extract_style`),
  `workflows/style-extract.md`, `workflows/load.ts`, `run-workflow.ts`, `loop/prompt.ts` (untrusted or
  extracted guides wrapped as data).
- CLI: `packages/cli/src/style-extract.ts`, `main.ts`, `agent.ts`, `config.ts`.
- App: `engine-host/e2e-style.ts`, `engine-host/agent.ts`, `handlers.ts`, `index.ts`, `main/index.ts`,
  `shared/api.ts`, `renderer/editor/StyleGallery.tsx`, `AgentPanel.tsx`, `ui-store.ts`, `use-styles.ts`,
  `scripts/stage-resources.ts`; app spec IPC table (`styles.extract`).
- Scripts and evidence: `scripts/style-ab.ts`, `docs/evidence/phase-15/`.

## Verify results
- `pnpm -C packages/agent test -- style-extract`: 9 passed.
- `pnpm -C packages/engine test -- styles/extract-untrusted-hook`: 4 passed (S8).
- `uv run --project py pytest -k "ocr or measure or palette"`: 14 passed.
- `pnpm -C apps/desktop e2e -- style-gallery`: 2 passed (the full E2E set also ran once: 11 passed, 1 skipped `@local`).
- Full vitest, typecheck, lint: see "Verify (after merging main)" below.

## Step 6 — live extraction (by owner delegation)
- Reference: `docs/evidence/phase-07/reference/attentioncompound/7633685885615115550.mp4` (720x1280,
  68 s, gitignored; owner allowed the download 2026-10-11). Not `reel.mp4`.
- `vox style extract <file> --name "Attention Compound" --json` with `vision` = `ollama:qwen3.5:latest`
  in a temporary `VOX_HOME`: 224 s, `describedBy: Ollama qwen3.5:latest`, extends `vox`, validate ok,
  no unmatched layouts. Result: `docs/evidence/phase-15/extract-result.json`, `draft-style/`.
- Run 1 failed with `PY_TOOL_FAILED` (palette): the dev CLI used the installed 1.0.0 app's
  `py-env` (Application Support tools folder), which has no `vox_py.palette`. With an empty
  `VOX_TOOLS_DIR` it used the repo `py/`. A new app build resyncs `py-env` (source hash), so this
  only hits a dev CLI next to an older installed app.
- Run 2 described nothing: qwen3.5 answered caption case "mixed"; the whole description was
  dropped (measurements-only draft). Fixed by `repairDescription` (D-70). Validate also flagged
  `vox/paper-tear: move cue tear at frame 19: peak motion is at frame 23`: the re-skin's colours move
  where the pixel difference peaks; inherited cue timing is now a note (D-70).
- Draft (run 3): colours from the measured palette (ink #151517, paper #C3B4A1, accent #20395A,
  highlight #B97F56); fonts Oswald / Anton / Crimson Pro; motion fade, frame hold 2; caption preset
  `attention-compound/reference` (from `vox/word-reveal`, mixed case, 50 %); pacing beat 950 ms
  (70 shots in 68 s, median 0.9 s); overlays paper-grain and film-look on.

## GATE 8 — A/B (by owner delegation; NOT a blind human A/B)
`scripts/style-ab.ts` renders the offline talking-head clip twice with the same scenes (map, stat,
kinetic text, end title) and each style's default caption preset at the preset's position, gives the
renders random names and writes the key to a separate file. It measures the reference and both clips
with the extraction's own measure step (`ab-metrics.json`).

| Round | clip-1 | clip-2 | Palette ΔE (clip-1 / clip-2) | Caption case (ref `asis`) | Caption y diff |
|---|---|---|---|---|---|
| 1 | extracted | vox | 12.3 / 14.9 | asis / upper | 25.5 / 10.8 (script left both at the sequence default 75 %) |
| 2 | vox | extracted | 14.3 / 12.8 | upper / asis | 0.3 / 1.7 |

Judgement (round 2, made from the metrics and the frame sheet before the key was opened): clip-2 is
closer. It has the reference's mixed-case italic narration line, the warmer dark tones with grain,
and the smaller palette distance; clip-1 has the boxed mono upper-case look of `vox`. The key says
clip-2 is the extracted style, so the extracted style wins. Round 1 agrees (extracted closer on
palette and case).

Honest limits: the AI built the set, so the judge knew the two candidates and the method; the
randomisation only kept the clip order hidden until the judgement. Neither clip has the reference's
two-tier caption (italic serif line plus a boxed mono keyword). The caption font is the
`word-reveal` look, not the extracted Crimson Pro. Pacing is the same in both (the scene layout is
fixed), median shot 3x the reference. Frames: `docs/evidence/phase-15/ab-clips-sheet.jpg`; the sheet
with reference frames is in the gitignored `docs/evidence/phase-15/reference/`. TODO.md asks the
owner for a real blind A/B (optional, may overrule).

## Review findings (self-review (token budget))
- Security: the report is static escaped HTML in a `sandbox=""` frame served with CSP_MEDIA; the
  renderer cannot start `style.extract` through `jobs.start`; a file path from the renderer is
  refused outside test builds (main opens the dialog); the draft's own `build.mjs` never runs (S8);
  an extracted guide reaches the system prompt as data. No finding open.
- Fixed in review: jsdom renderer tests could not run the engine (data folder by URL); the E2E
  dialog answer arrives as an array.
- Open: model output is free text inside the guide (escaped, capped); `paper-grain` was switched on
  for a footage-based reference because the model said "paper".

## Deviations
- Caption cards (PNG) instead of `drawtext` for the fixture (D-17).
- Cue timing of inherited templates in a re-skin is a validate note, not a problem (D-70).
- Engine `resources.ts` finds `data/` and `py/` by `import.meta.dirname`, not `new URL(…, import.meta.url)`.

## MANUAL STEPS
- Optional: a blind A/B by the owner (TODO.md "phase 15 · GATE 8").
- Optional: an extraction with an OpenRouter vision model (needs a key; TODO.md).

## Handoff notes
- `vox style extract` with a dev CLI next to an older installed app: set `VOX_TOOLS_DIR` to an empty
  folder (see Step 6) until the app is rebuilt.
- Caption position: a sequence keeps its own caption position (default 75 %); the extracted preset's
  `position` only applies when the preset position is set on the sequence. A later phase could set it
  when "Set as style for this sequence" changes the caption preset.
- v2 (LLM-authored templates, review approval mode) stays designed but unscheduled.

## Verify (after merging main)
- Full vitest (`vitest run`, all packages): 2619 passed, 1 skipped, 2 failed under load; both pass alone
  (24/24): `history/cursor.test.ts` "undo depth is 500 entries" (60 s timeout while 7 other phases ran)
  and `stages/ytdlp.test.ts` (the run was started through `npx`, which sets `npm_config_noproxy`; the
  plain vitest binary passes). No test was changed.
- Phase tests after the merge: 40 passed (agent style-extract 9, engine S8 4 + map 11, app api 1 file,
  renderer extract 2). `VOX_SLOW=1` `extract.slow.test.ts`: 3 passed. E2E `style-gallery`: 2 passed.
- pytest `-k "ocr or measure or palette"`: 14 passed. `pnpm -r typecheck` + root `tsc`: clean. `pnpm lint`: clean.

## GATE 8 round 3 (D-91; the owner decides, the AI does not pass this gate)
The owner's round 2 answer was "no one especially the font". Owner input during round 3 (relayed):
the reference also plays with depth: "wasn't" behind the microphone (12.2 s), "artist" on the chest
under a chain pendant (26.3 s), "Bad" over a framed photo edge with "Bunny" arriving as wide letters
that tighten (3.4 s).

What changed:
- Fonts: OFL faces from google/fonts (URL and sha256 in `packages/engine/data/fonts/SOURCES.md`):
  Instrument Serif (Regular and Italic), pixel faces VT323, DotGothic16, Silkscreen (Regular, Bold),
  Pixelify Sans, Jersey 10, Micro 5, and italic files of Crimson Pro, DM Serif Display, Libre Caslon
  Text, Lora and Playfair Display. Catalogue 64 entries, 46 families; the catalogue test now checks every sha256, an upright
  sibling for each italic file, and that `closestFont` never returns an italic file.
- Measured font match (`vox_py.fontmatch`): OCR caption lines are cropped, binarized (Otsu, the text
  class by glyph count) and compared with the same text rendered in every catalogue font and weight
  (tolerant F1 plus axis and stroke terms, tracking solved per line, horizontal stretch). Pixel-stepped
  lines only accept faces with the same hard axis. Best family per tier with its score and runners-up.
- Caption preset: with measured fonts the draft gets a generated two-tier preset
  (`data/captions/two-tier.html`): tier 1 in the matched italic serif, tier 2 emphasis runs as a flat
  box in the pixel face, upper case, letters knocked out (screen blend, with a 55 % ink copy on top so
  they stay readable on light footage), a red/cyan fringe, a tracking reveal on single-word chunks.
  Single-tier chunks show tier 1 only. The preset never re-wraps: the engine's lines decide.
- Text behind the subject: occlusion detection in extraction (Apple Vision subject mask over the
  caption boxes: text pixels inside the mask much rarer than outside) turns on the additive preset
  field `behindSubject`. The final render then also renders the picture without captions and
  `vox_py.behind` composites the subject over the captions on beats where the subject covers 8-65 % of
  the caption. Mattes are per frame (Vision about 22-40 ms each at 540 px short side), cached by frame
  hash in the project cache; per-shot keyframes were not needed.
- `vox style validate` gets `caption-gap` (no caption text in the gap between fixture chunks). It
  caught the first A/B render's bug: boxes of earlier chunks stayed on screen.

Live extraction (Ollama `qwen3.5:latest`, empty `VOX_TOOLS_DIR`, scratch home; the reference
`attentioncompound/7633685885615115550.mp4`, 720x1280):

| Tier | Lines | Pick | Score | Next |
|---|---|---|---|---|
| 1 (mixed case) | 13 | Instrument Serif Italic | 0.794 | Instrument Serif (upright) 0.654 |
| 2 (upper case, boxed) | 7 | VT323 | 0.690 | DM Mono 0.816, not eligible (smooth axis on pixel-stepped lines) |

Two tiers in 25 % of sampled frames; box fill `#FEFBFC` (median), knockout, no rule; fringe 1.5 px at
1080; tracking reveal 2 of 21 single-word captions; behind the subject in 4 of 10 frames that could
tell (60 checked). Run 1 took 12 min 22 s; run 2 1 h 27 min under load (load average 20-48 from other
agents). Run 2 `validate.ok` is false only because the HyperFrames preview render timed out
(`Page.captureScreenshot timed out`); `vox style validate attention-compound --no-render` on the draft
with the final template: ok (caption-preset 4, caption-safe-area 8, caption-states 4,
caption-emphasis 4, caption-seek 4). Draft: `docs/evidence/phase-15/draft-style-round3/`.

A/B set (`scripts/style-ab.ts`, round 3): the offline talking-head fixture in `vox` and in the draft,
captions over the footage only (no scenes), the same cuts (5420, 11180, 14740 ms) and off-centre
punch-ins, the same caption chunks and emphasis words (11 characters a line), random clip names, the
key in a separate file the AI did not open. The draft's render put 3 of 22 caption beats behind the
speaker (6734, 7350, 18700 ms). Files: `ab-round3-clip-1.mp4`, `ab-round3-clip-2.mp4`,
`ab-round3-clips-sheet.jpg`, `ab-round3-metrics.json`, `ab-round3-key.json`; the judge's sheet
`ab-round3-sheet.jpg` (reference frames on top, both clips at the same beats, font strip) is
gitignored because it holds reference frames.

Honest limits:
- The tier 2 face is the closest pixel face in the catalogue, not the reference's: the reference's
  strokes are heavier (font strip). Score 0.690 against 0.794 for tier 1.
- Occlusion detection is a heuristic: Vision sometimes counts large caption text as foreground;
  "wasn't" (12.2 s) was not decided and "artist" (26.3 s) was not read by OCR. One subject matte puts
  text behind the whole subject; "between the chest and the pendant" (two depths) is not possible.
- Behind the subject is render only (the preview shows captions in front) and costs a second picture
  render plus one re-encode. On a centred talking head a short caption lies fully over the speaker
  (no beat qualifies), which is why the A/B frames the punch-ins off centre.
- Knockout letters are grey, not the footage, on light footage (the ink copy); the fringe is 1.5 px.
- The fixture footage is a portrait on a test card, so colour bars show at the frame edges of the
  punch-ins in both clips.
- `ab-round3-metrics.json` lists each clip's caption case, which hints at the styles.
- Process slip: one shell command in the worktree ran a bare `python3 -` (no input, no effect)
  instead of `uv run`; reported to the coordinator.

Review: self-review (token budget).

Verify (worktree, after merging main at 52b4c6b):
- `pnpm typecheck`, `pnpm lint`: clean.
- vitest (engine, cli, desktop, styles): 1917 passed, 4 failed: three `*.local` tests with no fixture
  outputs (`make.sh` not run in the worktree) and `history/cursor.test.ts` "undo depth" (60 s timeout
  under load; 7/7 alone).
- pytest: 218 passed, 1 failed: `test_imagegen` (the Z-Image-Turbo model is not installed here). In
  a first run `test_audioqa` "good mix" failed under load; 48/48 alone.
- Slow: `extract.slow.test.ts` 3 passed. `validate.slow.test.ts`: the new `caption-gap` and two-tier
  tests pass; "a good style" and "appear cue" fail on `sfx-kit` (fixture `pop.wav` fails
  `notSynthesised` and `cleanEdges`), the same on main without this branch, so not from round 3.
- The old two-tier template fails the new `caption-gap` check ("again" still shown at 1600 ms); the
  new one passes every caption check.

## Demo clip after D-93, D-94, D-95 (2026-10-13)
Style re-extracted as `attention-compound-r3b` (D-93 preset: `tiered`, track 5 words / 2 lines / 25 characters, auto emphasis, 50 %; grain measured 0.02, paper-grain off). Clipper `--count 1 --length 30-60 --style attention-compound-r3b --yes-sources --yes` on fresh copies of the demo project (ollama qwen3.5, $0), render `--quality standard`, vidprep.
- Run 1 (main 2710475): 6 scenes; boxed tier 2 shows ("MATEMATIKA,", "80", "20 RIBU"), 50 %, readable on the light wall, no visible grain. Two `vox/paper-collage` scenes planned with `items: []` became striped placeholders (0:23-0:31): fixed in D-95.
- Run 2 (main c5daeaa): no placeholder; 3 scenes with English labels ("Math & Faith", "Unexpected Blessings"); captions behind the subject hide parts of words on the face (0:16, 0:24).
- Run 3 (main c5daeaa), sent to the owner: 4 scenes (kinetic-serif twice, newspaper, text-overlay), each starts on its spoken words (moves 2833 → 1040, 11593 → 5351, 19660 → 15533 ms); boxed tier shows ("BERKEMBANG,"). Defects seen: the text-overlay label is English ("Opportunities beyond imagination. ...") on an Indonesian clip and overlaps the boxed caption at 0:26; tier 1 word spaces look too tight ("tuh nggak pernah" reads as one word); scene text and caption repeat the same words at 0:02 and 0:07. The newspaper body columns are the template's seeded greeked text by design.
