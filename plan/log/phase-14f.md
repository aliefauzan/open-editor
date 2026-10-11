# Phase 14f — Audio ducking

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-12 · |
| Model | Sonnet 5.5 · high |
| Machine | M5, macOS 27; seven other phase agents run at the same time (CPU load) |
| Branch | phase/14f-audio-ducking (worktree `.worktrees/phase-14f`) |

## Pre-check
Prerequisite 13 merged on main (ee82856, D-60). Review: self-review (token budget).

## Plan summary
1. Model: audio track gets optional `duck: boolean` (additive; no `schemaVersion` bump). `updateTrack` op takes `duck`.
2. Mix graph (`audio/graph.ts`): a ducked track is a track that is not a captions source. Its clips are mixed
   into one track bus, then `sidechaincompress` keyed by the speech bus (every speech clip after its gain-to-target,
   volume, fades and delay), before the final `amix`. Speech, SFX and unducked tracks are untouched. No speech clips: duck is a no-op.
   Stems keep the same ducking so `other.wav` is what the mix hears.
3. Inspector toggle: "Duck under speech" on an audio track (track-level; shown when an audio clip is selected).
4. Tests first: graph snapshot (ducked + unducked), op test, schema test, slow test with a speech-over-music
   fixture (music level in speech windows drops, `vox audio-qa` passes with unchanged thresholds), renderer component test.
Test order: schema/op, graph snapshot, slow mix, inspector.

## Checklist
- [ ] schema + op
- [ ] graph + snapshot
- [ ] slow fixture + audio-qa
- [ ] inspector toggle
- [ ] spec edit (engine "Audio")
- [ ] review, verify, merge

## Files created / changed
## Verify results
## Done when
## Review findings
## Deviations
## MANUAL STEPS
## Handoff notes
