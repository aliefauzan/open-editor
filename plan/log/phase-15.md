# Phase 15 — Styles Part C: style from a reference video

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-12 · — |
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
- [ ] 1 fixture + measurement tests
- [ ] 2 describe + map (mocked model)
- [ ] 3 validate draft + S8 test
- [ ] 4 report via `vox-media://` with the untrusted-HTML CSP
- [ ] 5 gallery E2E
- [ ] 6 real reference + real vision model (delegated)
- [ ] 7 A/B script + GATE 8 (delegated)
