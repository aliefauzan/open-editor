# Progress — Vox Studio

Legend: `[ ]` not started · `[~]` in progress / waiting for a gate or manual step · `[x]` done · `[!]` blocked
Dates are local (YYYY-MM-DD HH:MM). Each phase edits only its own row.

| Phase | Title | Status | Started | Finished | One-line result | Log |
|---|---|---|---|---|---|---|
| 00 | Foundation | [ ] | | | | log/phase-00.md |
| 01 | Spike + GATE 1 | [ ] | | | | log/phase-01.md |
| 02 | Engine: model, ops, history | [ ] | | | | log/phase-02.md |
| 03 | Engine: styles loader, `base`, compile, captions, audio | [ ] | | | | log/phase-03.md |
| 04 | Engine: jobs, Python bridge, ingest, transcribe, facetrack | [ ] | | | | log/phase-04.md |
| 05 | Engine: assets, render, export, CLI + GATE 2 | [ ] | | | | log/phase-05.md |
| 06 | Style tooling (Part A rest) | [ ] | | | | log/phase-06.md |
| 07 | `vox` style v1 + GATE 3 | [ ] | | | | log/phase-07.md |
| 08 | App shell + security + GATE 4 | [ ] | | | | log/phase-08.md |
| 09 | App: first-run setup + `.dmg` | [ ] | | | | log/phase-09.md |
| 10a | App: editor core A (store, preview, timeline, inspector) | [ ] | | | | log/phase-10a.md |
| 10b | App: editor core B (quick clips, subtitles, media bin, export, gallery) + GATE 5 | [ ] | | | | log/phase-10b.md |
| 11 | Agent core | [ ] | | | | log/phase-11.md |
| 12 | Agent workflows: clipper + free-form | [ ] | | | | log/phase-12.md |
| 13 | App: agent panel + settings + v1.0 | [ ] | | | | log/phase-13.md |
| 14 | v1.1 (done when 14a–14g are all [x]) | [ ] | | | | log/phase-14.md |
| 14a | `vox` v1.1 templates + GATE 6 | [ ] | | | | log/phase-14a.md |
| 14b | Screenplay match workflow | [ ] | | | | log/phase-14b.md |
| 14c | Claude Code skill | [ ] | | | | log/phase-14c.md |
| 14d | Local image generation (mflux) | [ ] | | | | log/phase-14d.md |
| 14e | Clip speed + GATE 7 | [ ] | | | | log/phase-14e.md |
| 14f | Audio ducking | [ ] | | | | log/phase-14f.md |
| 14g | FCPXML export option | [ ] | | | | log/phase-14g.md |
| 15 | Styles Part C: style from reference | [ ] | | | | log/phase-15.md |

## Gates and milestones

| Point | After phase | Status | Decision (D-NN) | Notes |
|---|---|---|---|---|
| Specs approved (Revision 3) | — | [x] | D-10 | approved 2026-10-10; licence MIT |
| GATE 1 — HyperFrames go/hybrid, preview strategy, opaque sandbox | 01 | [ ] | | |
| Contracts frozen: `project.json`, ops, `HistoryEntry`, path rule | 02 | [ ] | | changes after this need a DECISIONS entry |
| GATE 2 — engine done-when (URL → MP4 by CLI, `vox quick`, OTIO in Resolve) | 05 | [ ] | | |
| Contracts frozen: Engine API + events, engine CLI | 05 | [ ] | | R2 rows "frozen after 05" |
| GATE 3 — `vox` side-by-side sheet approved | 07 | [ ] | | |
| GATE 4 — timeline library benchmark | 08 | [ ] | | |
| Contract frozen: `window.vox` API | 08 and 05 | [ ] | | freezes when both are done (it wraps the engine API) |
| GATE 5 — 4-core done (`.dmg` on second account, manual editing, quick clips, latency) | 10b | [ ] | | |
| v1.0 — friend installs from README and exports a clip | 13 | [ ] | | |
| GATE 6 — sheet for the 4 new `vox` templates | 14a | [ ] | | |
| GATE 7 — clip-speed design | 14e | [ ] | | |
| GATE 8 — blind A/B of an extracted style | 15 | [ ] | | |
