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
- [ ] 1 Design note in the engine spec
- [ ] 2 `playbackRate` spike + evidence
- [ ] 3 GATE 7 decision (owner delegation)
- [ ] 4 Schema v3 + migration
- [ ] 5 `setClipSpeed` op + speed-aware ops
- [ ] 6 Captions / word ranges
- [ ] 7 Compile + audio `atempo`
- [ ] 8 Exports, view, agent, app inspector
- [ ] 9 Review, Verify, log, merge
