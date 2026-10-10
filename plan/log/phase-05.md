# Phase 05 — Engine: assets, render, export, CLI + GATE 2

Status: [~] waiting: GATE 2 (2026-10-11, single agent, worktree `.worktrees/phase-05`, branch
`phase/05-engine-assets-render-export`, pushed, not merged; owner asked to cut token cost: no subagents,
self-review)

## Plan (full phase run)

Early packages did 8c core (E3, D-25), 8d0 and the Python part of 8d (P2, D-27). This run:
1. Assets (A1–A4): `stages/assets.ts` Commons + Openverse search with the licence allowlist (S7),
   cache, `fetch` through `fetchPublic` (S29), `cutout` (rembg, `py/vox_py/cutout.py`), `generate`
   via `imageProviders`; recorded HTTP fixtures, live smoke test `slow`.
2. Render and export (B5–B8e): `stages/render.ts` (silent HyperFrames render + `engine.mix` mux,
   `-c:v copy` + AAC), `--range-ms`, `--all`, `--captions`, `--loudness`; `exportCaptions`,
   `exportTimeline` (`py/vox_py/timeline.py`, OTIO + layer MOVs), `credits`, `frames`, `preview`;
   every export through `writeExport` (S32); job `audioQa` + kit sheet.
3. Facetrack path provider (9b), offline project script (10), A/V sync on the 90 s fixture (11).
4. Quick clips (12, 12b) + caption round trip (13); CLI for every command (`--json`).
5. Integration test (9); `scripts/gate2.sh`; GATE 2 evidence prep; MANUAL STEP 15 (Resolve).
Test order: licence → search/fetch → cutout/timeline pytest → providers → captions export →
targets wiring → render → OTIO → credits → preview → audioQa → loudness → framing provider →
offline project → quickClips → integration → A/V sync → caption round trip → gate2.sh.

Resume notes: none yet.

## Checklist

Early packages (D-19) did 8c core (E3, D-25), 8d0 and the Python part of 8d (P2, D-27). This run:
- [x] 1–4 Assets: Commons + Openverse search with the licence allowlist (S7: NC/ND/GFDL dropped, BY-SA
      warning, ND cutout → `LICENSE_REFUSED`), recorded HTTP replies, cache, `fetch` through
      `fetchPublic` (S29: private/loopback host or redirect refused, fake resolver), `cutout` (rembg +
      u2net, alpha PNG), `ImageProvider` + fake provider; `generate` without one → `PROVIDER_MISSING` + hint.
- [x] 5–8e Render (silent HyperFrames MP4 + `engine.mix` mux), `frames`, SRT/VTT, OTIO + layer MOVs,
      `credits`, `preview` (spawn spy), export targets on every export (S32), `audioQa` job + kit sheet,
      `--loudness` presets within ±1 LU (mix true peak −1.5 dBTP, D-32).
- [x] 9 Integration test (fixture → ingest → transcribe → clips + `base/title` → captions → draft render + SRT).
- [x] 9b Facetrack path provider in compile (`facetrack` and `auto` keyframes equal the builder's output).
- [x] 10 `scripts/make-offline-project.ts` (CI, no network; seeded shots/facetracks used; draft render).
- [x] 11 A/V sync after the mux on the 90 s spike fixture: max |offset| 0.69 ms, 21 pairs, frame 33.3 ms.
- [x] 12, 12b `quickClips` job + heuristic (speech, energy, hook, coverage), scorers, one undo entry.
- [x] 13 Caption edit round trip (SRT + DOM check), `captions: false`, `vox quick --render` 3 MP4 + 3 SRT.
- [~] 14 `scripts/gate2.sh` written; local sections pass (below). URL sections wait for the owner's URLs.
- [ ] 15 MANUAL STEP (Resolve), in TODO.
- [ ] 16 GATE 2: stopped, questions in TODO.

## Files created / changed

Branch `phase/05-engine-assets-render-export` (13 commits, 04b648c … f2c917e):
- Engine: `src/assets-api.ts`, `src/stages/assets.ts`, `src/export-api.ts`, `src/quick-api.ts`,
  `src/stages/quickClips.ts`, `src/api.ts` (jobs, `quickClips` registry, `trackedFraming`),
  `src/compile/compile.ts` (`captions?`), `src/audio/graph.ts` (true peak), `src/errors.ts`,
  `src/media-api.ts`, `src/stages/ingest.ts`.
- Python: `py/vox_py/cutout.py`, `py/vox_py/timeline.py`, schemas + tests; `pyproject.toml` / `uv.lock`
  (`rembg==2.0.85`, `opentimelineio==0.18.1`).
- CLI: `packages/cli/src/main.ts` (assets, compile, preview, frames, render, audio-qa, export-captions,
  export-timeline, credits, quick); tests `export.test.ts`, `quick.local.test.ts`.
- Scripts: `scripts/make-offline-project.ts`, `scripts/gate2.sh`, `scripts/gate2-frames.ts`; root
  `tsconfig.json` includes `scripts`; `.prettierignore` keeps the recorded asset replies as recorded.
- Tests: `test/assets/*`, `test/export/*` (render, timeline, av-sync, caption-roundtrip),
  `test/export-target-wiring.test.ts`, `test/audio-qa.test.ts`, `test/compile/framing-provider*`,
  `test/compile/spike90-project.ts`, `test/quick-clips*.test.ts`, `test/integration.slow.test.ts`,
  root `test/offline-project*.test.ts`.

## Verify results

Fixtures from `make.sh` first (2026-10-11 07:20):
- Root `pnpm test`: 123 files, 1735 passed, 1 skipped (again after prettier: same).
- `rtk proxy pnpm lint` and `pnpm typecheck`: clean.
- `uv run --project py pytest -k audioqa`: 51 passed; full pytest: 120 passed.
- `pnpm -C packages/engine test:slow -- integration`: 1 passed (real mlx-whisper transcribe on the M5).
- `pnpm -C packages/engine test -- export-target audio-qa`: 3 files, 53 passed.
- `spike90.slow.test.ts` after its refactor (bench lock): 1 passed.
- A/V sync (`test/export/av-sync.slow.test.ts`, bench lock): render 62 s, 2700 frames, 21 click/flash
  pairs, max |offset| 0.69 ms, mean 0.15 ms (bar: 1 frame = 33.3 ms). `docs/evidence/phase-05/av-sync-spike90.json`.
- `bash scripts/gate2.sh` (local sections only, no URLs yet): exit 0, 6 of 6 sections pass.
  `docs/evidence/phase-05/14-gate2-summary.json`.

## Done when

- [x] 1 Spike result and pin in the engine spec (01, D-29).
- [x] 2 `vox doctor` passes on the M5 (04; warnings only).
- [x] 3 `pnpm test` passes (above).
- [ ] 4 Real YouTube URL → 9:16 MP4 (face-tracked speaker, `base/title`, crossfade, captions + SRT):
      `gate2.sh --youtube` ready; waits for the URL.
- [ ] 5 `.otio` in Resolve: MANUAL STEP 15 (fallback chain ready, below).
- [x] 6 Recovery test (02) passes in `pnpm test`.
- [~] 7 `vox quick` → 3 captioned clips + edited caption word: passes on the fixture
      (`quick.local.test.ts`, `caption-roundtrip.slow.test.ts`); the URL run waits for the URL.
- [~] 8 Local file ingest + `--out-dir` outside the project pass (`14-quick-local.json`); Instagram,
      TikTok and the `LOGIN_REQUIRED` check wait for the URLs.
- [x] 9 `vox audio-qa` writes `qa.json`, `qa.png`, `LISTEN.md` (`14-audio-qa-*`); every check fails on
      its bad fixture (`audio-qa.test.ts`, pytest).
- [x] 10 29.97 fps: 3 clips at 30000/1001, 0 mismatched frames; VFR: 2 clips against the CFR copy,
      167 + 171 frames, 0 mismatches (`14-frames-*.json`); `removePauses` = 1 history entry, one undo
      restores the sequence (`14-undo-check.json`); newer `schemaVersion` → `SCHEMA_TOO_NEW`, file tree
      hash unchanged (`14-schema-too-new.json`).
- [x] A/V sync < 1 frame on the 90 s fixture (0.69 ms).
- [x] Facetrack path builder plugged into the compile path provider (9b).
- [x] S7, S29, S32 tests pass; self-review: no CRITICAL/HIGH.
- [ ] GATE 2 answered and recorded.

## Review findings

Self-review (owner asked to cut token cost): code, TypeScript, Python and security (S7, S29, S32). No
CRITICAL/HIGH. Fixed MEDIUM: `vox audio-qa` on a sequence crashed with a TypeError (the result's `files`
is an object there and a list in kit mode); found by the gate2 local run, CLI test added (it failed
before the fix). Checked: archive downloads go through `fetchPublic` (each hop resolved once, dialled by
the checked address, size cap); the cutout model is SHA-256 pinned and the tool never downloads; preview
spawns `npx` with an argument array; every export goes through `writeExport` (absolute path, existing
folder, no silent replace); HyperFrames gets an allowlisted environment (no API keys); evidence has no
personal paths (`gate2.sh` writes `~`).

## Licences (step 3, R5)

- rembg 2.0.85: MIT ("MIT License", rembg `LICENSE.txt`).
- Model `u2net.onnx` from the rembg release `v0.0.0`, SHA-256
  `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`: U^2-Net by xuebinqin, "Apache
  License, Version 2.0" (U-2-Net `LICENSE`). Never `bria-rmbg` (non-commercial).
- opentimelineio 0.18.1: Apache-2.0. `otio-fcpx-xml-adapter` not added (only if Resolve rejects the OTIO).

## Deviations

- Implementation choices: D-32 (mix true peak −1.5 dBTP, a contract change in the engine spec; licences,
  render defaults, OTIO layout) and D-33 (quick clips heuristic details, scorer fallback, CLI `-o`,
  GATE 2 frame check reference). New error codes: `LICENSE_REFUSED`, `PROVIDER_MISSING`.
- Done-when 10 frame check uses `contain` framing for the check only (undone after), so the counter is
  on screen whatever `auto` crops; timing is what is checked.
- Local `vox quick` evidence clips use `--length 4-8` (the fixtures are 20 s).

## MANUAL STEPS

- Step 14 URL sections and step 15 (Resolve): in TODO "Manual steps" and the GATE 2 row.
- Fallback chain for step 15 (D-10), prepared: (1) open `GATE2 YouTube-Main.otio` from
  `docs/evidence/phase-05/reference/` (the projects folder printed by `gate2.sh` must stay); (2) if
  Resolve rejects it, the agent adds FCPXML export through `otio-fcpx-xml-adapter` (pin in R5) and the
  owner tries the `.fcpxml`; (3) if both fail, the agent writes README steps to place the layer MOVs from
  `<name>-layers/` by hand. Any of the three passes done-when 5.

## Handoff notes

- Job kinds on `engine.jobs` (14, `media-jobs.test.ts`): `assets.cutout`, `assets.fetch`,
  `assets.generate`, `assets.search`, `audioQa`, `exportCaptions`, `exportTimeline`, `facetrack`,
  `frames`, `ingest`, `quickClips`, `render`, `shots`, `transcribe`.
- 10b: `quickClips` result `{ sequenceIds, clips, scorer, scorerError?, note?, candidates }`; captions
  edits are `setCaptions` overrides keyed `<mediaId>:<transcriptRev>:<index>`.
- 11/12: `engine.quickClips.registerScorer(id, fn)` gets `{ candidates[{index,startMs,endMs,text}], prompt }`
  and returns one score per candidate; a throw falls back to the heuristic.
- Engine API, events and CLI freeze when GATE 2 passes (R2).
- Re-run `bash scripts/gate2.sh --youtube <url> --instagram <url> --tiktok <url> [--walled <url>]
  --evidence <ROOT>/docs/evidence/phase-05` after the owner gives the URLs.

## Early steps (D-19) — e3-media-export

- **Steps done**: 8c core (export targets, S32): `{ file }` / `{ dir }` / project `renders/`;
  absolute path, existing writable folder, else `EXPORT_PATH`; hidden short temp in the target folder,
  atomic no-replace move (`link` + `unlink`, placeholder + `rename` without hard links); `{ file }`
  needs `overwrite`, `{ dir }` adds ` (2)`, `renders/` adds `-2`; a temp swapped meanwhile is refused;
  failed or cancelled exports leave nothing; temps of a killed engine (this host, pid gone) are swept
  by the next export. Decision: D-25.
- **Files** (branch `early/e3-media-export`): `packages/engine/src/export/target.ts`,
  `src/fs/no-replace.ts`, test `packages/engine/test/export/target.test.ts`.
- **Tests**: 39 (targets, every `EXPORT_PATH` case incl. null and string targets, read-only folder,
  no silent replace, a file appearing mid-export, cancel during a running ffmpeg → `CANCELLED`, ffmpeg
  killed → `TOOL_FAILED`, a SIGKILLed engine process's temp swept, host/pid sweep rules, symlink and
  file swaps of the temp, 255-byte names, `safeStem`). All in the root `pnpm test` (242 passed).
- **Error codes**: `EXPORT_PATH` (new, in the shim), `CANCELLED`.
- **Left for phase 05**: shim → `errors.ts`; render / `exportCaptions` / `exportTimeline` wiring onto
  `writeExport` (pass the signal to ffmpeg via `produce`); OTIO `<name>-layers/` folder; `--all`; CLI
  flags (`--out`, `--overwrite`); the app's save dialog passes `{ file, overwrite: true }`.
- **Branch**: `early/e3-media-export`, shim swapped to errors.ts after 02; merged to main as bfcdb3f; worktree
  removed (verify: pnpm test 1238 passed / 1 skipped, pytest 109 passed).

## Early steps (D-19) — p2-audioqa

Date: 2026-10-11. Branch `early/p2-audioqa` (worktree `.worktrees/early-p2-audioqa`), merged into main with `--no-ff` after main was merged into the branch and Verify re-ran. No phase-02 code touched.

**Steps done**: 8d0 (audio QA fixture set) and the Python part of 8d (`py/vox_py/audioqa.py`, mix mode and kit mode, the thresholds file, the outputs).

**Files**
- `packages/engine/test/fixtures/make.sh` (new `--audio-qa` set, also run by the default call), `packages/engine/test/fixtures.slow.test.ts` (duration, channel and cue-count checks).
- `py/vox_py/audioqa.py`, `audioqa_dsp.py`, `audioqa_render.py`, `audioqa_thresholds.json`.
- `py/tests/test_audioqa.py`, `py/tests/schemas/audioqa.request.json`, `py/tests/schemas/audioqa.result.json`, `py/tests/test_tool_protocol.py` (tool list).
- `py/pyproject.toml` and `py/uv.lock`: `numpy==2.5.3` (exact, already locked through onnxruntime and mediapipe). Recorded in R5. No Pillow.

**Decision**: D-27 (qa.png drawn with numpy, no `drawtext`; the onset, claim and kit definitions; request field names). Engine spec "Audio QA" and the phase-05 deliverables line edited to match.

**Tests and numbers**
- `uv run --project py pytest`: 109 passed (48 in `test_audioqa.py`). With `CI=1` the `local` tests skip and the synthetic ones still run.
- Each bad mix fails exactly its own check; the good mix passes all five. Good mix: -14.1 LUFS, true peak -5 dBTP, smallest SFX-over-speech margin 19.85 LU. The loud-SFX case drops below the 6 LU limit. The clipped case fails all three loudness parts.
- The loudness meter is within 0.03 LU of ffmpeg `ebur128` on the fixtures (test allows 0.1).
- `fixtures.slow.test.ts`: 21 tests passed. Root `pnpm typecheck`, `lint`, `test`: 17 files, 407 passed, 1 skipped. ruff check and format clean; `uv lock --check` ok.
- Thresholds were not loosened (R3). Review round found and fixed: unbounded memory (streamed true peak, block K-weighting, 600 s mix cap, 4 s kit cap, 64 file cap), greedy cue claiming (now an order-preserving match), unchecked fps (23 to 61 only), empty or non-finite audio.

**Left for phase 05**
- Job `audioQa` and CLI `vox audio-qa [--loudness preset]` (maps the preset to the request `target`: youtube -14, tiktok -12, broadcast -23).
- Step 8e on real renders; rendering the stems and the mix from compile; mapping the compiled cues to the request `cues`; writing the kit sheet to `qa/kit-<styleId>.png`.
- Known limit: a band-limited noise bed passes the not-noise-bed rule; GATE 3 listening covers it.
