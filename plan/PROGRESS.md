# Progress — Vox Studio

Legend: `[ ]` not started · `[~]` in progress / waiting for a gate or manual step (`[~] waiting: manual <step>`, D-12) · `[x]` done · `[!]` blocked
Dates are local (YYYY-MM-DD HH:MM). Each phase edits only its own row.

| Phase | Title | Prereq | Status | Started | Finished | One-line result | Log |
|---|---|---|---|---|---|---|---|
| 00 | Foundation | — | [x] | 2026-10-10 23:40 | 2026-10-11 00:25 | Monorepo, fixtures, seed media, CI green (macos-14); no `drawtext`, barcode counter (D-17) | log/phase-00.md |
| 01 | Spike + GATE 1 | 00 | [x] | 2026-10-11 00:18 | 2026-10-11 03:13 | GATE 1 all pass: whole-sequence render 0.67× RT, preview opaque ≥ 26 fps, seek ≤ 67 ms, patch 31 ms, NTSC go, margin 20.8 % (D-29) | log/phase-01.md |
| 02 | Engine: model, ops, history | 00 | [x] | 2026-10-11 00:17 | 2026-10-11 02:26 | Model, 29 ops + `batch`, history store (kill-safe), lock, `vox new/op/undo/redo/history/snapshot/paths`; applyOp p95 22.9 ms; contracts frozen (D-28) | log/phase-02.md |
| 03 | Engine: styles loader, `base`, compile, captions, audio | 01, 02 | [x] | 2026-10-11 03:20 | 2026-10-11 04:35 | base style, compile (render + preview), captions, audio mix + stems + cues, layers MOV; 90 s spike fixture 0 cut errors (D-30) | log/phase-03.md |
| 04 | Engine: jobs, Python bridge, ingest, transcribe, facetrack | 01, 02 | [x] | 2026-10-11 04:43 | 2026-10-11 05:40 | Jobs on the engine (ingest, transcribe, shots, facetrack), yt-dlp + LOGIN_REQUIRED, doctor, CLI chain; seeds committed; D-31 | log/phase-04.md |
| 05 | Engine: assets, render, export, CLI + GATE 2 | 03, 04 | [x] | 2026-10-11 05:43 | 2026-10-11 15:30 | Assets, render + mux, exports, audio QA, quick clips, CLI; GATE 2 passed 12/12 with owner URLs (A/V 0.69 ms, frames exact 29.97/VFR); Resolve replaced by automated OTIO check (owner); long facetrack paths fixed for hyperframes lint; D-32, D-33, D-39 | log/phase-05.md |
| 06 | Style tooling (Part A rest) | 03 | [x] | 2026-10-11 07:31 | 2026-10-11 08:09 | `vox style validate/new/trust/accept/remove`, migrate, hook checks, safe area, `minEntranceMs`, caption preset and cue checks; base previews; style + caption preset formats frozen (D-34) | log/phase-06.md |
| 07 | `vox` style v1 + GATE 3 | 05, 06 | [x] | 2026-10-11 19:20 | 2026-10-11 21:55 | 4 templates, 2 transitions, 2 overlays (paper-grain, film-look), 3 caption presets (word-reveal with mixed-family emphasis), collage clipping + highlighter + archive grades; validate green; kit 8/8; demo audio QA pass; GATE 3 approved by owner delegation (D-46, D-47, D-48, D-49) | log/phase-07.md |
| 08 | App shell + security + GATE 4 | 01, 03 | [x] | 2026-10-11 08:17 | 2026-10-11 09:15 | Electron 44.7.0 shell: hardened schemes + IPC (S1, S10–S15, S28 pass), engine host in utilityProcess, fixture plays in opaque sandbox, skeleton ad-hoc dmg; GATE 4 pass (D-35, D-36, D-37) | log/phase-08.md |
| 09 | App: first-run setup + `.dmg` | 05, 08 | [x] | 2026-10-11 15:07 | 2026-10-11 17:25 | Setup screen + background doctor → Ready, packaged Resources (engine data, HyperFrames, py, pinned uv, `vox` CLI), fuses (S27), S31 unchanged, clean-install test pass, `.dmg` 180.6 MB; optional manual steps 7 and 9b open (D-41) | log/phase-09.md |
| 10a | App: editor core A (store, preview, timeline, inspector) | 06, 09 | [x] | 2026-10-11 17:29 | 2026-10-11 19:05 | Store + change records, preview pipeline (patch/reload), editor layout, timeline, inspector, keyboard + menus; latency patch max 194 ms / reload max 421 ms; UI gate: spec-layout check (owner delegated) (D-42) | log/phase-10a.md |
| 10b | App: editor core B (quick clips, subtitles, media bin, export, gallery) + GATE 5 | 10a | [~] waiting: GATE 5 | 2026-10-11 19:10 | | Quick clips, Subtitles panel, media bin, export dialog (Save to, loudness, audio check), gallery, error states; E2E 7/7, clean-install renders from the installed app, latency patch max 87 / reload max 435 ms; engine fixes (HyperFrames env, mix ffmpeg path, build swap); D-45; owner run open | log/phase-10b.md |
| 11 | Agent core | 05 | [x] | 2026-10-11 17:03 | 2026-10-11 19:22 | Agent loop, tools, plan mode, replay, probe runner, `vox config`; mocks green; real Apple probe ready + plan pass; live probe deferred to 13 (D-43, D-44) | log/phase-11.md |
| 12 | Agent workflows: clipper + free-form | 07, 11 | [ ] | | | | log/phase-12.md |
| 13 | App: agent panel + settings + v1.0 | 10b, 12 | [ ] | | | | log/phase-13.md |
| 14 | v1.1 (done when 14a–14g are all [x]) | 14a–14g | [ ] | | | | log/phase-14.md |
| 14a | `vox` v1.1 templates + GATE 6 | 13 | [ ] | | | | log/phase-14a.md |
| 14b | Screenplay match workflow | 13 | [ ] | | | | log/phase-14b.md |
| 14c | Claude Code skill | 13 | [ ] | | | | log/phase-14c.md |
| 14d | Local image generation (mflux) | 13 | [ ] | | | | log/phase-14d.md |
| 14e | Clip speed + GATE 7 | 13 | [ ] | | | | log/phase-14e.md |
| 14f | Audio ducking | 13 | [ ] | | | | log/phase-14f.md |
| 14g | FCPXML export option | 13 | [ ] | | | | log/phase-14g.md |
| 15 | Styles Part C: style from reference | 13 | [ ] | | | | log/phase-15.md |

## Gates and milestones

| Point | After phase | Status | Decision (D-NN) | Notes |
|---|---|---|---|---|
| Specs approved (Revision 3) | — | [x] | D-10 | approved 2026-10-10; licence MIT |
| Plan review 3 + owner requests applied | — | [x] | D-12, D-13, D-14 | review fixes; Instagram/TikTok/file input, chosen export folder; sound design + audio QA |
| Plan review 4 + owner answers applied | — | [x] | D-16 | checked-in seed media + `SEEDS.json`, `tap.wav` in 00, 10a prereq 06 + 09, GATE 2 platform fallback, GATE 3/6 3-round exit, gates inside a phase, Apple helper `notBuilt`, no second account or friend required, CI fast/slow split |
| Competitor teardown changes applied | — | [x] | D-15 | CapCut 9.4.1 teardown: rational fps + VFR copy, loudness match + export targets, VAD speech gate, word kinds, `shots`, `auto` framing + keyframes, `CaptionChunk`, pause/word removal, `coalesceKey`, `JOB_CONFLICT`, agent tool surface, aliases, sub-runs, replay tests; specs and plan updated, `schemaVersion` stays 2 |
| GATE 1 — HyperFrames go/hybrid, preview strategy, opaque sandbox | 01 | [x] | 2026-10-11, D-29 | all 9 items pass: HyperFrames go (whole sequence), opaque sandbox, no Preview fallback, NTSC go, no pre-render cache (margin 20.8 %) |
| Contracts frozen: `project.json`, ops, `HistoryEntry`, path rule | 02 | [x] | 2026-10-11, D-28 | also the transcript file format, `ApplyResult`, `engine.view` / `SequenceView` and `SCHEMA_TOO_NEW` (R2 rows "02"); changes after this need a DECISIONS entry |
| GATE 2 — engine done-when (URL → MP4 by CLI, `vox quick`, Instagram/TikTok/file ingest, export folder, audio QA, OTIO in Resolve) | 05 | [x] | 2026-10-11, D-39 | 12/12 pass by `scripts/gate2.sh` with the owner's URLs; no Resolve: automated OTIO check stands in (`15-otio-check.json`, Resolve not tested); Commons contact in local config only |
| Contracts frozen: Engine API + events, engine CLI | 05 | [x] | 2026-10-11, D-39 | R2 rows "frozen after 05" |
| GATE 3 — `vox` side-by-side sheet approved + ear check of `LISTEN.md` | 07 | [~] | | round 2 sent to the owner 2026-10-11 (TODO "Gates") |
| GATE 4 — timeline library benchmark | 08 | [x] | 2026-10-11, D-35 | decided by numbers: 119.7 fps in Electron 44.7.0, linked + marquee 3/3; keep the library |
| Contract frozen: `window.vox` API | 08 and 05 | [x] | 2026-10-11, D-39 | froze when 05 merged (08 done earlier the same day); grows 09–13 additively |
| GATE 5 — 4-core done (`.dmg` clean-install test + owner's run with a fresh `VOX_HOME`, manual editing, quick clips, latency; D-16) | 10b | [ ] | | |
| v1.0 — fresh-clone check + owner installs the Release `.dmg` from the README and exports a clip (friend optional, D-16) | 13 | [ ] | | |
| GATE 6 — sheet for the 4 new `vox` templates | 14a | [ ] | | |
| GATE 7 — clip-speed design | 14e | [ ] | | |
| GATE 8 — blind A/B of an extracted style | 15 | [ ] | | |
