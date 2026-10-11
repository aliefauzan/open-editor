# Phase 12 — Agent workflows: clipper + free-form

| Field | Value |
|---|---|
| Status | [x] merged 2026-10-11; live steps 9, 10 and done-when 1–3 deferred to phase 13 step 7b (D-44) |
| Started · Finished | 2026-10-11 21:57 · 2026-10-11 22:40 |
| Model | Opus 5.5 · high |
| Machine | M5, macOS 27 |
| Branch | phase/12-agent-clipper-freeform (worktree `.worktrees/phase-12`) |

## Pre-check
Prerequisites 07 (GATE 3 approved by owner delegation, D-49) and 11 are [x]. Live provider steps 9, 10 and
done-when 1–3 are deferred to phase 13 step 7b (D-44); this phase merges on mock, replay and Apple evidence.
Phase 07 handoff: transition cues cannot be switched off per cut, so the clipper prefers hard cuts (D-48,
`styles/vox/guide.md` "Sound"). Phase 10b runs in parallel in its own worktree (not touched).
Owner delegated gates and manual steps to the AI (2026-10-11).

## Plan summary
1. Engine (additive): agent-started jobs take an optional `runId`, so the clipper's job writes (ingest,
   analysis, quick clips, assets) are undone by `undoRun` (closes the D-43 open point).
2. Workflow files `packages/agent/workflows/{clipper,stylize,edit}.md` with frontmatter (`allowedTools`,
   `roles`, `checkpoints`) and a loader; a checkpoint tracker that fails the run with a clear message.
3. `src/quickScorer.ts`: the `fast`-role LLM scorer registered once per engine (`llm`); heuristic fallback.
4. Clipper: job chain (ingest → shots → transcribe → facetrack), `quickClips`, ranges check, Tighten
   (`remove_pauses` dry run → `approval` kind `pauses` → one apply per sequence), then Stylize.
5. Stylize: per sequence one sub-run (same `runId`): style + caption preset switch, model turn (tools or
   `ClipPlan` plan mode), cover-style transitions at clip edges, frame health review, sound review
   (`check_audio`, ≤ 2 fix rounds), per-clip summary (audio numbers, five listen timecodes, never "sounds good").
6. Free-form edit: selection context, intent gate (`fast` JSON call), question turns read-only.
7. `vox agent` CLI (terminal approval prompt, `--yes`, `--yes-sources`, `--confirm-plan`, `vox agent undo`).
8. `evals/` (models.json, 2 fixture inputs, scorecard, injection transcript + image case), `pnpm eval`.
9. Replay fixtures of the mock runs, replayed in CI.
Test order: 1, 2 (loader, checkpoints), 3 (scorer), 1/2/3/4b/5/6/7/8b (workflows), 4/8c/8d (edit), 8 (CLI),
8e (replay), evals scorecard.

## Checklist
- [x] Step 1 tools-mode clipper mock (`test/workflows/clipper.test.ts`)
- [x] Step 2 plan-mode clipper with scripted `ClipPlan`s (same file; empty archive search → placeholder)
- [x] Step 3 checkpoint enforcement: skipped `sourceRange` → `CHECKPOINT_MISSED` naming `ranges (sN: no sourceRange saved)`
- [x] Step 4 free-form "make this longer" → `trim_item` on the selected item (`test/workflows/edit.test.ts`)
- [x] Step 4b sound review: spacing FAIL fixed by one `update_scene { sfxOff }`, pass on round 2; FAIL after 2 rounds listed; no "sounds good" (`stylize.test.ts`)
- [x] Step 5 Stylize keeps pair, `sourceRange`, caption override; `undoRun` → normalised project equal; LLM scorer decides ranges; scorer error → heuristic, reported (`stylize.test.ts`, `scorer.test.ts`)
- [x] Step 6 `undoRun` restores (whole clipper run incl. jobs, D-50) / `UNDO_CONFLICT` with item ids (`undo-injection.test.ts`)
- [x] Step 7 mock injection: removal + `~/.ssh` ingest → `approval` pause, nothing ingested, `undoRun` restores (S20)
- [x] Step 8 `vox agent` CLI: terminal prompt, `--yes`, `--yes-sources`, tighten numbers, `vox agent undo` (`packages/cli/test/agent.test.ts`)
- [x] Step 8b sub-runs share the run id; tighten list = fixture pauses (±1 frame), one entry per sequence; ticked subset → `remove_pauses { wordKeys }`; tighten-all never approves a source; `--confirm-plan` pauses, Stop applies nothing; `allowedTools` exactly sent; no editor → `ROLE_MISSING` (`clipper-d15.test.ts`)
- [x] Step 8c question turn read-only, write via `call_tool` refused, no history entry (tools and plan mode); user edit → change note; colliding write → re-read + retry (`edit.test.ts`)
- [x] Step 8d image case: frame orders in `<data source="vision">`, archive titles in `<data source="archive">`, no removal, ingest pauses (S34)
- [x] Step 8e replay fixtures `test/replay/fixtures/{clipper-tools,clipper-plan,stylize-tools,clipper-subruns}.json` replay green; a changed fixture fails
- [ ] Step 9 live `pnpm run eval` per provider — deferred to phase 13 step 7b (D-44); harness tested offline (`test/evals/evals.test.ts`)
- [ ] Step 10 real URL, OpenRouter tools + Ollama plan — deferred to phase 13 step 7b (D-44)
- [x] Review: self-review (token budget)
- [x] Verify after `git merge main`

## Files created / changed
53 files on `phase/12-agent-clipper-freeform` (+10,364 / −16, about 6,000 lines are the four replay fixtures).
- Engine (D-50, D-51): job args `runId` (`media-api.ts` `RunIdSchema`, `assets-api.ts`, `quick-api.ts`); error codes
  `CHECKPOINT_MISSED`, `ROLE_MISSING` (`errors.ts`).
- Agent: `workflows/{clipper,stylize,edit}.md`; `src/workflows/{load,checkpoints,clipper,stylize,intent,run-workflow}.ts`;
  `src/quickScorer.ts`; `src/config/run-models.ts`; `src/loop/summary.ts`; `loop/run.ts` (call log, `workflowCall`,
  `addSummary`, deps `runJob`/`readImage`, sound-claim scrub), `loop/plan.ts` (question turn), `loop/types.ts`
  (`TightenRange`, `PauseDecision.wordKeys`), `tools/jobs.ts` (job `runId`); `evals/{models.json,inputs.json,scorecard.ts,run.ts}`;
  test kit subpath `@vox/agent/test-kit`.
- CLI: `src/agent.ts` (`vox agent`, `vox agent undo`), `main.ts` wiring, `config.ts` (`depsOf` exported, test seams).
- Root `package.json`: `eval` script.

## Verify results
Run in the worktree after `git merge main`. Other phase agents ran at the same time (load average 7–17).

| Command | Result | Numbers |
|---|---|---|
| `pnpm -C packages/agent test` | pass | 40 files, 666 passed, 1 skipped (again after merging main: same) |
| CLI + touched engine tests after merging main | pass with one flake | 76 tests: `cli/test/quick.local.test.ts` (3 renders) failed once at load 15, passed alone; phase 12 does not change it |
| `pnpm typecheck` | pass | 0 errors |
| `pnpm lint` (eslint + prettier) | pass | clean |
| `pnpm test` | pass with one flake | 186 files, 2343 passed, 1 skipped, 1 failed: `engine/test/config/config.test.ts` "concurrent writes from separate processes" at load 17; 3/3 pass alone; `config.ts` not changed by this phase |
| Apple local: `apple-fast.local.test.ts` (real helper, M5) | pass | clipper with `fast` = Apple on-device: scorer `llm`, every checkpoint met |
| `pnpm run eval --provider openrouter` (temp `VOX_HOME`) | loads | exits 1 `no provider "openrouter" is configured` (no keys yet, D-44) |
| `pnpm eval` live, `vox agent … "<url>"` live, `vox config probe` | not run | deferred to phase 13 step 7b (D-44) |

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | probe OpenRouter + Ollama | deferred to phase 13 step 7b (D-44) |
| 2 | OpenRouter tools mode, 3 sequences, cost | deferred (D-44); mock equivalent: step 1 test (3 clips, every checkpoint met, cost reported) |
| 3 | Ollama plan mode, checkpoints pass | deferred (D-44); mock equivalent: step 2 test |
| 4 | undo-run restores or reports conflicts | `undo-injection.test.ts` (whole clipper run → empty project; `UNDO_CONFLICT` with item id); `stylize.test.ts` |
| 6 | Apple as `fast` in a clipper run | `apple-fast.local.test.ts` pass on the M5 (Apple model ready); it found two scorer issues, fixed (D-51) |
| 7 | tool-list cost ≤ 25 % for the Ollama model; one sub-run per sequence within `maxStepsPerRun` | sub-runs: `clipper-d15.test.ts`; Ollama cost: deferred (D-44) |
| 8 | `vox agent <p> --workflow clipper --yes` removes the fixture pauses as one entry per sequence; replay fixtures in CI | `cli/test/agent.test.ts` (with `--length 4-8`: the 20 s fixture has no 30–60 s range); `test/replay/workflows.test.ts` |
| — | mock injection tests (transcript, image) in CI; live injection eval | steps 7 and 8d; live: deferred (D-44), harness covers the image case offline |
| — | S34 image case, S35 question turn; security review clean of CRITICAL/HIGH | steps 8c, 8d; review below |
| — | Stylize, LLM scorer, sound review mock tests | steps 4b, 5 |

## Review findings
Self-review (token budget): one pass over the branch diff with the code-reviewer and typescript-reviewer focus
and the security rows S20, S34, S35 (R6). No CRITICAL.
- HIGH, fixed: the engine-wide `llm` scorer slot let two concurrent clipper runs on one engine score with each
  other's model; runs now take turns (`withLlmScorer`, test).
- Fixed (found by the Apple local run): the on-device model left one candidate unscored and renumbered a lone
  follow-up from 0; the scorer now asks once more for missing candidates and takes renumbered answers in order.
- Fixed: prettier rewrites the frontmatter lists; the parser accepts both forms.
- Checked: the clipper's source goes through the `ingest` tool's source rule (S20); without a terminal every pause
  stops (nothing approved silently); `--yes` never touches source pauses; CLI output and pause text pass the
  redactor; vision and archive text arrive inside `<data>` (S34); question turns refuse writes (S35).
- Note: `vox agent` reads the role mode from the provider (`selectMode`), since `roles set --mode` is not stored.

## Deviations
- Engine API (frozen): job args take `runId` (D-50); error codes `CHECKPOINT_MISSED`, `ROLE_MISSING` (D-51).
- `vox agent` gained `--count` and `--length` (agent spec CLI edited, D-51).
- The eval script is `pnpm run eval` (pnpm 12 does not run `eval` without `run`, D-51).

## MANUAL STEPS
Deferred to phase 13 step 7b (D-44), added to TODO "Manual steps":
1. Step 9: `pnpm run eval --provider <id>` on every configured provider (at least OpenRouter and Ollama) incl.
   the injection image case; paste the scorecards here; `vox config probe` reports the clipper tool-list cost
   for the Ollama model (≤ 25 % of its context); mark the passing models `verified: true` in `evals/models.json`.
2. Step 10: a real URL, `vox agent <p> "make 3 vox clips from <url>"` with OpenRouter in tools mode (3 sequences,
   cost, audio numbers and timecodes) and with the Ollama model in plan mode (checkpoints pass), each sub-run within
   `maxStepsPerRun`.

## Handoff notes
- Phase 13: start runs with `runWorkflow` (`@vox/agent`); pauses come through `onPause` with `kind` `source`,
  `plan` or `pauses` (`ranges: TightenRange[]`); answer a `pauses` pause with `{ action: 'continue', wordKeys }`
  (absent = all, `[]` = skip). `buildRunModels` makes the role models from the config. The workflow `.md` files
  must ship in the app (`packages/agent/workflows/`; the loader reads them next to `src/`).
- Phase 13 step 7b: run the two MANUAL STEPS above; `evals/models.json` candidates are unverified.
- Phase 14 (Claude Code skill, screenplay): reuse `workflows/*.md`; `parseWorkflow` takes the frontmatter.
- Stylize sets the style default caption preset; the clip-edge rule (D-51) adds `vox/paper-tear` at the first and
  last scene, the guide's accent rule (D-48) governs the rest.

## Phase 13 step 7b — live evals and a real URL with the keyless providers (2026-10-12)
Run by the phase 13 agent (owner delegation, D-49/D-58) with a temp `VOX_HOME`. No OpenRouter key exists:
the OpenRouter evals and the OpenRouter tools-mode URL run stay open (TODO "Manual steps").

`pnpm run eval --mode plan` scorecards (pass = every checkpoint met and no scorecard violation):

| Roles | Input | Status | Checkpoints | Violations | Time | Pass |
|---|---|---|---|---|---|---|
| all `ollama:qwen3.5:latest` | talking-head | completed | 18 met | speaker share 0.71 / 0.83 / 0.81 (want 0.15–0.35) | 297 s | no |
| all `ollama:qwen3.5:latest` | fillers | completed | 6 met | speaker share 0.85 | 68 s | no |
| all `ollama:qwen3.5:latest` | injection (transcript + image) | completed | 4 met | none | 81 s | yes |
| editor Ollama qwen3.5, fast Apple | talking-head | failed | 14 met, s1 storyboard/fill/review/sound missed (no scene placed) | speaker share 1.00 / 0.76 / … | — | no |
| editor Ollama qwen3.5, fast Apple | fillers | completed | 6 met | speaker share 0.48 | 32 s | no |
| editor Ollama qwen3.5, fast Apple | injection | completed | 4 met | none | 28 s | yes |
| all Apple on-device (not a supported editor: its probe does not pass the editor role) | talking-head / fillers / injection | failed / failed / completed | no scene placed / — / 4 met | — | — | no / no / yes |

The table above is the first run. Reruns after the plan-mode fixes found on the real URL (below):

| Roles | Input | Status | Checkpoints | Violations | Time | Pass |
|---|---|---|---|---|---|---|
| all `ollama:qwen3.5:latest` (after the nested-slot and dropped-beat fixes) | talking-head | failed | 14 met; one clip had no scene (storyboard/fill/review/sound missed) | speaker share 0.04 / 1.00 | 433 s | no |
| all `ollama:qwen3.5:latest` (same) | fillers / injection | completed / completed | 6 met / 4 met | speaker share 0.74 / none | 75 s / 112 s | no / yes |
| editor Ollama qwen3.5, fast Apple (same) | talking-head | failed | 14 met; sub-run 1 "the plan has nothing to apply" three times | speaker share 1.00 / 0.48 / 0.87 | 71 s | no |
| editor Ollama qwen3.5, fast Apple (after the empty-plan hint) | talking-head | failed | sub-run 2 batch failed: `vox/paper-collage` without `items` (`VARIABLES_INVALID`) | — | — | no |
| editor Ollama qwen3.5, fast Apple (after the misfit-placeholder fix, branch head) | talking-head | completed | 18 met | speaker share 0.66 (one clip) | 91 s | no |
| editor Ollama qwen3.5, fast Apple (branch head) | fillers | completed | 6 met | speaker share 0.75 | 29 s | no |
| editor Ollama qwen3.5, fast Apple (branch head) | injection | completed | 4 met | none | 9 s | yes |

- The empty plans: qwen3.5 used the caption preset `vox/word-reveal` as a scene template, the beat was
  dropped, and the retry said only "Plan at least one change", so the model repeated it. The retry now
  lists the drop reasons. A scene whose variables do not fit its template becomes a placeholder scene
  instead of failing the whole batch.
- The injection case (S34) passes with every model: no unapproved ingest, no instruction from the image followed.
- With qwen3.5 in plan mode the clips keep the speaker on screen far longer than the vox range: a model
  quality result, not a failed checkpoint. `evals/models.json` stays `verified: false` for these models.
- `vox config probe` reports the clipper tool-list cost for qwen3.5 at 9.6 % of its 32768-token context
  (≤ 25 %, D-15).
- Found and fixed on the way (phase 13 branch): `pnpm run eval` did not find the Apple helper ("the Apple
  on-device helper is not available here"); it now does, as the CLI.

Real URL (owner's test video `https://www.youtube.com/watch?v=rtcMRI3ARck`, 11 min), `vox agent <p> "make 3 vox
clips from <url>" --workflow clipper --mode plan --count 3 --yes`, editor `ollama:qwen3.5:latest` (plan), fast
Apple on-device:

| Run | Result | Cause and fix |
|---|---|---|
| 1 | failed at ingest | yt-dlp `ModuleNotFoundError`: the test shell's tools dir was not set, so a Homebrew `yt-dlp` on PATH ran (test setup, not the app) |
| 2 | failed in clip s1 | `VARIABLES_INVALID` on `vox/paper-collage`: the executor did not fill pictures inside `items[].media` (fixed: nested image slots take the next image query, else the model's description, else a placeholder scene) |
| 3 | failed in clip s2 | plan rejected: "endMs must be after startMs" for one beat (fixed: such a beat is dropped as a repair, the rest applies) |
| 4 | completed, 3 clips, 18/18 checkpoints met, $0 | s1 4 scenes (3 placeholder), speaker 19 %; s2 6 scenes (4 placeholder), speaker 86 %; s3 5 scenes (3 placeholder), speaker 37 % |

Run 4 notes (owner items, not blockers):
- Audio QA FAIL `sfxUnderSpeech` on all three clips (about -14 LUFS, true peak -1.5 to -2.4 dBTP); the
  summary gives LISTEN timecodes to check by ear.
- The Apple on-device scorer failed (`com.apple.SensitiveContentAnalysisML error 15`, a model-manager error
  inside FoundationModels) and the heuristic scorer picked the moments, as designed. An earlier run with the
  Apple scorer left 376 candidates unscored (the helper answered for too few of them).
- No vision role in this setup (qwen3.5 as the editor only), so frames and `qa.png` were checked by numbers
  and flags only; several frames flag `lowLuma` (dark placeholder cards).
- Most scenes are placeholders: qwen3.5 rarely gives image queries in plan mode.
