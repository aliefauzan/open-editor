# Phase 14e — Clip speed + GATE 7

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-12 05:52 · — |
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
- [ ] 4 Schema v3 + migration
- [ ] 5 `setClipSpeed` op + speed-aware ops
- [ ] 6 Captions / word ranges
- [ ] 7 Compile + audio `atempo`
- [ ] 8 Exports, view, agent, app inspector
- [ ] 9 Review, Verify, log, merge

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
