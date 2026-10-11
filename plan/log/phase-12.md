# Phase 12 — Agent workflows: clipper + free-form

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-11 21:57 · |
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
- [ ] Steps 1–8e (tests first, `MockLanguageModelV4`, offline fixture)
- [ ] Step 9, 10 — deferred to phase 13 step 7b (D-44)
- [ ] Review (self-review, token budget)
- [ ] Verify after `git merge main`
