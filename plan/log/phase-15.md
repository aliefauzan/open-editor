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
