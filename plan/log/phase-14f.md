# Phase 14f — Audio ducking

| Field | Value |
|---|---|
| Status | done (merged) |
| Started · Finished | 2026-10-12 05:40 · 2026-10-12 |
| Model | Sonnet 5.5 · high |
| Machine | M5, macOS 27; seven other phase agents ran at the same time (CPU load, full suite 275 s) |
| Branch | phase/14f-audio-ducking (worktree `.worktrees/phase-14f`) |

## Pre-check
Prerequisite 13 merged on main (ee82856, D-60). Review: self-review (token budget).

## Plan summary
1. Model: audio track gets optional `duck: boolean` (additive; no `schemaVersion` bump). `updateTrack` takes `duck`.
2. Mix graph (`audio/graph.ts`): a ducked track is a track that is not a captions source. Its clips are mixed
   into one bus, then `sidechaincompress` keyed by the speech bus (every speech clip after its gain-to-target,
   volume, fades and delay), before the final `amix`. Speech, SFX and unducked tracks are untouched. No speech clips: duck is a no-op.
   Stems keep the same ducking so `other.wav` is what the mix hears.
3. Inspector toggle "Duck under speech" on the audio clip's track (disabled on a speech track).
4. Tests first: graph snapshot, op test, slow render tests (real speech over pink-noise music; synthetic
   long gap; `audioQa` job), renderer test.

## Checklist
- [x] schema + op (`duck`, test in `test/ops/sequences.test.ts`)
- [x] graph + snapshot (`test/audio/duck.test.ts`, `__snapshots__/duck.txt`); existing graph snapshot unchanged
- [x] slow fixture + audio QA (`test/audio/duck.slow.test.ts`, CLI `vox audio-qa` on the fixture project)
- [x] inspector toggle (`Inspector.tsx` `DuckRow`, test in `components.test.tsx`)
- [x] spec edit (engine "Audio", Track, updateTrack; app out-of-scope line) with D-61
- [x] review, verify, merge

## Files created / changed
- `packages/engine/src/model/schema.ts` (`duck` on audio tracks), `src/ops/sequences.ts` (`updateTrack` duck),
  `src/audio/graph.ts` (`DUCK_FILTER`, bus + detector wiring).
- `packages/engine/test/audio/duck.test.ts`, `duck.slow.test.ts`, `__snapshots__/duck.txt`, `test/ops/sequences.test.ts`.
- `apps/desktop/src/renderer/editor/Inspector.tsx`, `src/shared/project.ts`, `test/renderer/components.test.tsx`.
- `packages/agent/src/tools/ops.ts` (updateTrack tool text).
- Docs on main: engine spec, app spec, DECISIONS D-61.

## Verify results
| Command | Result | Numbers |
|---|---|---|
| `pnpm test` (full, branch head, 7 other agents running) | pass after fixes of env | 2486 passed; 4 failed first run: 3 `.local` tests needed the gitignored `fixtures/out` (copied from root, 4/4 pass), `cursor.test.ts` "undo depth is 500 entries" timed out under load (7/7 alone) |
| `pnpm -C packages/engine test -- audio/duck` | pass | 7 tests (snapshot, order, per-track, no-op cases, stems) |
| `VOX_SLOW=1` `packages/engine/test/audio` | pass | 10 tests: existing mix tests unchanged, 3 new |
| Real speech over pink-noise music | music -11.5 dB while speech active | gaps (400 ms) reopen it by more than 3 dB; speech stem levels equal on/off (< 0.01 dB) |
| Synthetic speech-level noise, 2 s then silence | -9.6 dB under speech, within 1 dB after the 400 ms release | bar: < -8 dB |
| `vox audio-qa p_… --json` on the ducked project | pass | oneEventPerCue pass, spacing pass, sfxUnderSpeech pass, loudness pass, cueTiming skipped (no cues); thresholds untouched |
| typecheck, `pnpm lint` | clean | |

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | Mix-graph snapshot test | `test/audio/__snapshots__/duck.txt` |
| 2 | Speech-over-music fixture ducks | `duck.slow.test.ts` (-11.5 dB, -9.6 dB) |
| 3 | `vox audio-qa` passes with unchanged thresholds | job test in `duck.slow.test.ts` and CLI run above |
| 4 | Inspector toggle | `components.test.tsx` "Duck under speech" |

## Review findings (self-review, token budget)
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| self | MEDIUM | First thresholds (0.03, ratio 6) ducked a speech-level synthetic by only 5.9 dB; retuned to 0.04 / 5 and measured on real speech | yes |
| self | LOW | An older app opening a project with `duck` rejects the strict track schema; the flag is off by default, so only a user who turns it on is affected | noted |
| self | LOW | Live preview (HTML audio) does not duck; only the export mix and stems do | noted (handoff) |
| self | none | Filter text is built from constants and a boolean; no user string reaches ffmpeg (R4 unchanged) | — |

## Deviations
D-61 (flag name, keying on captions source tracks, SFX never ducked).

## MANUAL STEPS
None.

## Handoff notes
- The phase 13 note "audio QA flags `sfxUnderSpeech` on all 3 agent URL clips" is not ducking: clipper
  projects have no ducked track (default off), and ducking never touches the SFX stem the check measures.
  The check compares the SFX stem with the speech stem (needs >= 6 LU margin), so the lever is the cue gain /
  kit peak levels (phase 07 re-processed `thump-tap` and `timpani` for this), not the mix.
- Preview does not duck (approximation by design: the final mix never goes through the browser).
- Fixture projects for the QA tests are the checked-in talking-head clip plus generated noise; no new media in git.
- `.local` engine tests need `packages/engine/test/fixtures/out` (run `bash packages/engine/test/fixtures/make.sh`
  or copy it) in a fresh worktree.
