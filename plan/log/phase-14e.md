# Phase 14e — Clip speed + GATE 7

| Field | Value |
|---|---|
| Status | done (merged f67a91a) |
| Started · Finished | 2026-10-12 05:52 · 2026-10-12 07:38 |
| Model | Opus 5.5 · high (phase agent, no subagents) |
| Machine | M5, macOS 27.0.1 |
| Branch | phase/14e-clip-speed (worktree `.worktrees/phase-14e`) |

## Pre-check
Prerequisite 13 merged on main (ee82856, D-60; checked by the orchestrator). Runs in parallel with
14a–14d, 14f, 14g and 15 (other worktrees; CPU load during measurements). GATE 7 is decided by owner
delegation (D-49, D-58): the AI writes the design note and the spike, reviews the design against the
numbers (A/V sync, frame accuracy, migration safety), records the decision, then builds.
Fixtures from `packages/engine/test/fixtures/out` in the root checkout (`VOX_FIXTURES`).

## Plan summary
1. Design note: new engine spec subsection "Clip speed" (`MediaClip.speed`, `schemaVersion` 3 with a
   load-time migration 2 → 3, duration rule `inMs + durationMs × speed`, op, compile, audio `atempo`).
2. Spike: HyperFrames `data-playback-rate` on a render build of the 90 s barcode/flash/click fixture at
   0.5× and 2×, with the mix built by hand with `atempo`; frame accuracy and flash/click offsets.
3. GATE 7 by owner delegation: critical review of the note against the spike numbers; D-NN.
4. Build (contract change, R2): schema + migration, `setClipSpeed` op, speed-aware source arithmetic
   in every op (trim, split, ripple, replaceMedia, invariants, handles), captions and word ranges,
   compile (`data-playback-rate`, framing paths), audio graph (`atempo` chain), OTIO export,
   `engine.view`; app inspector field and timeline/subtitle mapping; agent read tool mapping.
5. Review (self-review, token budget), Verify, log, merge.
Test order: model/migrate → ops/speed → captions/words → audio/atempo → compile → render/speed (slow)
→ app inspector component test.

## Checklist
- [x] 1 Design note in the engine spec ("Clip speed")
- [x] 2 `playbackRate` spike + evidence
- [x] 3 GATE 7 decision (owner delegation, D-62)
- [x] 4 Schema v3 + migration
- [x] 5 `setClipSpeed` op + speed-aware ops
- [x] 6 Captions / word ranges
- [x] 7 Compile + audio `atempo`
- [x] 8 Exports, view, agent, app inspector
- [x] 9 Review, Verify, log, merge

## Spike and GATE 7 (by owner delegation)
Spike `spike/bench/speed.ts` (analysis `spike/bench/speed-analyze.ts`), run under the bench lock with the
other phase agents running (load average 14–25). The engine compiles the 90 s barcode/flash/click fixture
as plain clips with the timeline lengths; the spike adds `data-playback-rate` to the `<video>` tags,
renders with HyperFrames 0.8.145 (`--quality draft`, `--strict-all`), builds the mix by hand
(`atrim` → `aresample` → `atempo` → `atrim` → `adelay` → `amix`) and muxes.

| Run | Picture (expected source frame) | A/V flash vs click | Render |
|---|---|---|---|
| 1: 2×, 0.5×, 1×, plain `atempo` | 510/510 exact | 8 pairs, max 33.31 ms (0.5×), 2×: −3.9…−17.2 ms | 14.5 s for 17 s |
| 2: + 4× and 0.25× picture-only, 1024-sample preroll | 960/960 exact (all five speeds) | 10 pairs, max 9.35 ms | 50.3 s for 32 s (load 25) |

Isolated `atempo` (ffmpeg 8.1.2, click every 0.73 s, `atempo-timing.json`): plain, the sound is early by a
mean of 45 ms at 0.5×, 11 ms at 2×, i.e. about 1024 input samples / speed at 48 kHz. With a 1024-sample
preroll: 0.5–2× within −14.5…+14.9 ms; 0.25× (two stages) −31.8…+42.7 ms; 0.4× up to 39.4 ms;
3–4× in sync but 9–14 of 26 clicks lost.

Review (critical, by owner delegation; round 1 → round 2):
- Round 1 design (plain `atempo`) failed the A/V bar: 33.31 ms at 0.5× is not under one frame
  (33.33 ms). Revised: 1024-sample preroll before `inMs`; sound clips limited to 0.5–2×.
- Picture: `data-playback-rate` is frame exact, so the plan's fallback (ffmpeg pre-processed copies)
  is not needed.
- 60 fps sequences: ±15 ms is under one 60 fps frame (16.7 ms), but with little margin; the slow test
  checks 30 fps (the done-when fixture).
- Migration safety: the migration 2 → 3 only sets the number; the store writes
  `snapshots/auto-pre-migrate-v2.json` first; v2 snapshots restored later are migrated on read; history
  entries stay valid (the field is optional); an older engine gets `SCHEMA_TOO_NEW` and writes nothing.
  14f's `AudioTrack.duck` (D-61, no bump) is optional too and belongs to v3.
- Preview at speed is not measured (no GUI tool); the HyperFrames runtime sets the element
  `playbackRate`. Listed for the owner's screen check.
Decision: GATE 7 passes with the revised design (D-62). Evidence: `docs/evidence/phase-14e/`
(`spike-playbackrate.json`, `atempo-timing.json`, `spike-index.html`).

## Build (contract change, R2; D-62)
Branch commits: 35a2d32 (spike), 7edd2a9 (schema v3, migration, op, speed-aware ops), 1a69cb7
(captions, compile, mix, view), 5913ce7 (OTIO, agent), 4d8f86c (app), a31a567 (render slow test),
f8c06bf (app spec); main merged in four times (c628491, 5a0c955, the 14g merge, d7bb642), all clean.
- Engine model: `src/model/speed.ts` (range constants, `spanMs`, `sourceAt`, `timelineAt`,
  `toSourceMs`), `src/model/migrate.ts` (`migrate2to3`, registered by default in `ProjectStore`),
  `schema.ts` (`SCHEMA_VERSION = 3`, `MediaClip.speed`, 0.01 steps).
- Ops: `src/ops/speed.ts` (`setClipSpeed`, linked clips follow, `onOverlap: 'error' | 'ripple'`, manual
  crop pins keep their source moment); source arithmetic × speed in trim, split, fit, `replaceMedia`,
  fps re-snap, `NO_HANDLES`, `MEDIA_BOUNDS`; invariants: no speed on images, sound only 0.5–2×.
- Words and captions (`ops/words.ts`), compile (`data-playback-rate` on `<video>` and preview `<audio>`,
  range cuts and crossfade early starts × speed), framing provider in source time, `engine.view`
  `speed`, mix (`audio/graph.ts`: 1024-sample `atempo` preroll, silence pad near source start, cut to
  the timeline length; 1× graph unchanged).
- OTIO: `timeScalar` per clip → `LinearTimeWarp` (`py/vox_py/timeline.py`, request schema); the source
  range keeps the timeline length. FCPXML ignores it (D-64 known limit: the adapter writes no speed).
- Agent: `set_clip_speed` tool (generated), op description, `view_frames` `srcMs` × speed, Stylize pair
  check includes `speed`.
- App: Inspector "Speed" row (`setClipSpeed`, ripple; 0.25–4 video, 0.5–2 audio, hidden on images),
  In/Out in source time, trim limits, thumbnails, waveform, subtitle mapping, optimistic trim;
  `shared/project.ts` `speed` + `sourceSpanMs`. App spec Inspector bullets updated.

## Verify (2026-10-12, worktree after merging main d7bb642)
| Command | Result |
|---|---|
| `pnpm test` (load 6.0) | 2535 passed, 1 skipped, 1 failed: `history/cursor > undo depth is 500 entries` timed out (60 s) under load; re-run alone: passed (18.1 s; the same test takes 39.9 s on main at load 11.7) |
| `pnpm -C packages/engine test -- ops/speed model/migrate audio/atempo compile/speed model/captions` | 5 files, 37 passed |
| `VOX_SLOW=1 vitest run packages/engine/test/render/speed.slow.test.ts` (bench lock, load 6.0 → 5.2) | 1 passed, 24.4 s |
| `VOX_SLOW=1 vitest run packages/engine/test/export/timeline.slow.test.ts -t "sped clip"` | 1 passed |
| `pnpm -C apps/desktop test` | 383 passed, 2 failed: `agent panel placeholder > links to settings`, `next-steps bar > "Captions only" ...`; both fail without this phase's changes too (also recorded on main by 14b) |
| `uv run --project py pytest -q py/tests` | 152 passed |
| `rtk proxy pnpm lint` | clean (eslint + prettier) |
| `tsc` root + `pnpm -r typecheck` | no errors |

## Done-when evidence
- Design approved: GATE 7 passed by owner delegation (D-62), section above.
- Spike result recorded: `docs/evidence/phase-14e/spike-playbackrate.json`, `atempo-timing.json`.
- 0.5× and 2× render in sync through the real render job (`render/speed.slow.test.ts`,
  `docs/evidence/phase-14e/render-speed.json`): 960/960 frames show the expected source frame at
  0.25×, 0.5×, 1×, 2×, 4×; 10 flash/click pairs, max |A/V| 15.92 ms (0.5×; 2× within 3.96 ms) < 33.3 ms
  (one frame at 30 fps). The engine path is a little worse than the spike's 9.35 ms (the mix is
  resampled once more), still under half a frame.

## Review findings (self-review (token budget); code, TypeScript, Python focus)
- Fixed: Inspector speed field reused the id `in-speed` of the framing "Track speed" select (label
  collision, found by the existing framing test); renamed `in-clip-speed`.
- Fixed: `spike/bench/speed.ts` cast a v2 object to the v3 `Project` type (root `tsc` error).
- Checked, no change: `linkGroup` returns the selected item first; ripple longer inserts the gap at the
  old end (the clip itself is not split); ripple shorter applies the new lengths before the cut; 1× mix
  graph strings unchanged; keyframes stay inside the new length; migration only sets the number and the
  store copies the v2 file first; older engines get `SCHEMA_TOO_NEW`.
- UI gate: spec-layout check only (the Speed row uses the existing `Row`/`NumberField` pattern next to
  In/Out, as the updated app spec says); no Playwright screenshot (no GUI tool, token budget).
No HIGH or CRITICAL left open.

## Deviations
- `schema.test` "rejects unknown fields" used `speed` as its unknown example; changed to `pitch` (the
  test still checks the same rule).
- FCPXML carries no speed (adapter limit, D-64); OTIO carries it as `LinearTimeWarp`.
- Sound speed limited to 0.5–2× (GATE 7 round 2: `atempo` beyond that is out of sync or loses
  transients); 0.25–4× only for picture without linked sound (`unlinked: true` or no sound clip).

## MANUAL STEPS
- Optional, does not block (owner at the screen; no GUI tool here): preview playback at speed in the
  app (TODO item added).

## Handoff notes
- `schemaVersion` 3 is the v1.1 schema: 14f's `AudioTrack.duck` (D-61) is part of it; later optional
  fields need no bump, new required meaning does (DECISIONS D-62).
- Any new op touching `inMs` must use `src/model/speed.ts` helpers (source = timeline × speed).
- FCPXML (14g) ignores `timeScalar`; a later adapter fix could write `timeMap`.
- Two app component tests fail on main independently of this phase (see Verify).
