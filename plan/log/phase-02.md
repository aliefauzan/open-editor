# Phase 02 — Engine: model, ops, history

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-11 00:17 · |
| Model | Opus 5.5 · high |
| Machine | M5, macOS 27.0.1, Node 24.14.0, pnpm 12.0.0 |
| Branch | phase/02-engine-model-ops-history (worktree `.worktrees/phase-02`) |
| Resume from | |

## Pre-check
Prerequisite 00 is [x]. Phase 01 runs in parallel in `.worktrees/phase-01` (no shared files: 02 owns
`packages/engine/src/{model,ops,history,text}`, `paths.ts`, `errors.ts`, `log.ts`, `api.ts` and the CLI
commands it adds). Decisions read up to D-17.

## Plan summary
1. Errors (`VoxError` + codes) and the frame grid (`Fps`, `ms`, `frame`, `snap`, source-grid snap).
2. zod model (`schemaVersion: 2`, strict objects, D-15 fields), ids, transcripts, `computeWordKinds`.
3. normalise/denormalise into entities (`project`, `media:`, `sequence:`, `track:`, `item:`, `captions:`,
   `captionOverride:`), diff, apply changes.
4. Ops: one module per op group, each with an exported zod schema; shared rules (snap, overlap modes,
   linked items, sync-lock ripple/insert, locked tracks, track kinds, media bounds, template lookup stub).
   `removePauses`/`removeWords` on a word to timeline range helper.
5. History store: write order with fsync, lock (`O_EXCL`), recovery, cursor, `undoRun`, coalescing,
   `jobId` check, `ApplyResult`, `SCHEMA_TOO_NEW` + migration snapshot, rotation, snapshots.
6. `log.ts` rotation, `paths.ts` (path rule, projects folder), `api.ts` (`openEngine`, `view`).
7. CLI: `new`, `op`, `undo`, `redo`, `history`, `snapshot`, `paths` (`--json`, `--projects-dir`).

Test order: errors, frame grid (property), schema, normalise round trip, word kinds, one test file per
op, rule tests (all rates), history (change records, cursor, undoRun, coalescing, ApplyResult/jobId,
write order, schema safety, recovery with child-process kills, lock, rotation), log, view, paths (S1),
projects folder, CLI.

## Checklist
- [ ] A1 frame grid · A2 schemas · A3 normalise round trip · A3a word kinds
- [ ] B4 library ops · B5 sequence/track ops · B6 item ops · B6a caption/frame fields · B6b removePauses/removeWords · B7 rule tests
- [ ] C8 change records · C9 cursor · C10 undoRun · C10a coalescing · C10b ApplyResult/jobId · C11 write order · C11a schema safety · C12 recovery · C13 lock · C14 rotation/snapshots · C14b engine log · C14a view
- [ ] D15 path rule + projects folder · D16 CLI

## Files created / changed

## Verify results
| Command | Result | Numbers |
|---|---|---|

## Done when
| # | Item | Evidence |
|---|---|---|

## Review findings
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|

## Deviations

## MANUAL STEPS
None so far.

## Handoff notes
