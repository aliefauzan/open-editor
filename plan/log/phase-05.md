# Phase 05 — Engine: assets, render, export, CLI + GATE 2

Status: [~] in progress (2026-10-11, single agent, worktree `.worktrees/phase-05`, branch
`phase/05-engine-assets-render-export`; owner asked to cut token cost: no subagents, self-review)

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
