# Phase 02 — Engine: model, ops, history

| Field | Value |
|---|---|
| Status | done |
| Started · Finished | 2026-10-11 00:17 · 2026-10-11 02:26 |
| Model | Opus 5.5 · high |
| Machine | M5, macOS 27.0.1, Node 24.14.0, pnpm 12.0.0 |
| Branch | phase/02-engine-model-ops-history (worktree `.worktrees/phase-02`, removed at merge) |
| Resume from | |

## Pre-check
Prerequisite 00 is [x]. Phase 01 ran in parallel in `.worktrees/phase-01` (no shared files: 02 owns
`packages/engine/src/{model,ops,history,text}`, `paths.ts`, `errors.ts`, `log.ts`, `api.ts` and the CLI
commands it adds). Decisions read up to D-17 at the start, D-27 at the merge.

## Plan summary
1. Errors (`VoxError` + codes) and the frame grid (`Fps`, `ms`, `frame`, `snap`, source-grid snap).
2. zod model (`schemaVersion: 2`, strict objects, D-15 fields), ids, transcripts, `computeWordKinds`.
3. normalise/denormalise into entities (`project`, `media:`, `sequence:`, `track:`, `item:`, `captions:`,
   `captionOverride:`), diff, apply changes.
4. Ops: one module per op group, each with an exported zod schema; shared rules (snap, overlap modes,
   linked items, sync-lock ripple/insert, locked tracks, track kinds, media bounds, template lookup stub).
   `removePauses`/`removeWords` on a word to timeline range helper.
5. History store: write order with fsync, lock, recovery, cursor, `undoRun`, coalescing, `jobId` check,
   `ApplyResult`, `SCHEMA_TOO_NEW` + migration snapshot, rotation, snapshots.
6. `log.ts` rotation, `paths.ts` (path rule, projects folder), `api.ts` (`openEngine`, `view`).
7. CLI: `new`, `op`, `undo`, `redo`, `history`, `snapshot`, `paths` (`--json`, `--projects-dir`).

Test order: errors, frame grid (property), schema, normalise round trip, word kinds, one test file per
op, rule tests (all rates), history (change records, cursor, undoRun, coalescing, ApplyResult/jobId,
write order, schema safety, recovery with child-process kills, lock, rotation), log, view, paths (S1),
projects folder, CLI.

## Checklist
- [x] A1 frame grid · A2 schemas · A3 normalise round trip · A3a word kinds
- [x] B4 library ops · B5 sequence/track ops · B6 item ops · B6a caption/frame fields · B6b removePauses/removeWords · B7 rule tests
- [x] C8 change records · C9 cursor · C10 undoRun · C10a coalescing · C10b ApplyResult/jobId · C11 write order · C11a schema safety · C12 recovery · C13 lock · C14 rotation/snapshots · C14b engine log · C14a view
- [x] D15 path rule + projects folder · D16 CLI

## Files created / changed
- `packages/engine/src/`: `errors.ts`, `log.ts`, `paths.ts`, `api.ts`; `model/` (fps, schema, ids,
  normalise, diff, equal); `ops/` (core, invariants, library, sequences, items, timeline, scenes,
  captions, words, project, templates, index); `history/` (types, files, cursor, lock, store);
  `text/fillers.ts`.
- `packages/engine/package.json` (`./paths` subpath export, `test` script, zod 4.6.5 and ajv 8.20.0),
  `packages/engine/scripts/test.mjs` (`pnpm -C packages/engine test -- <filter>` runs
  `test/<filter>*`).
- `packages/engine/test/`: errors, log, paths, api, model/*, text/*, ops/* (one file per op group plus
  rules, core, templates), history/* (changes, cursor, undo-run, coalesce, apply-result, write-order,
  schema, recovery, recovery.kill with `fixtures/kill-child.ts`, rotation, lock, hardening), helpers.
- `packages/cli/src/main.ts`, `packages/cli/bin/vox.js`, `packages/cli/test/projects.test.ts`.

## Verify results
| Command | Result | Numbers |
|---|---|---|
| `pnpm -C packages/engine test` | pass | 46 files, 364 tests |
| `pnpm -C packages/engine test -- --run history/recovery` | pass | 2 files, 11 tests (incl. 15 random SIGKILLs plus a kill at each write step); repeated 3 times green after the last fix |
| `vox new demo --json` + `vox history "$ID" --json` | pass | version 1, one `addSequence` entry, actor `cli` |
| `vox paths --json \| jq -e '.projectsDir == $d'` | pass | `true` |
| root `pnpm typecheck && pnpm lint && pnpm test` | pass | 50 files, 402 tests |
| `applyOp` latency (300 renames, bench lock, M5) | logged | p50 17.0 ms, p95 22.9 ms, max 50.1 ms |

Re-run after `git merge main`: see the merge note below.

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | Every op and rule has passing tests at every rate in the fixed set (23.976, 29.97, 59.94 incl.) | every op has a test file in `test/ops/`; the rate-dependent ops and rules (placeClip, moveItem, trimItem, splitItem, rippleDelete, insert/overwrite, addScene, removePauses, snap helpers, canvas fps change) run under `describe.each(FPS_SET)` in `rules`, `core`, `splitItem`, `trimItem`, `removePauses` and `sequences` tests (grid and no-overlap checked after each step); the other ops do not use the rate |
| 2 | Engine done-when #6 (kill mid-write never loses or corrupts) | `test/history/recovery.kill.test.ts`: a SIGKILL at each write step (`locked`, `history-appended`, `temp-written`, `renamed`) and 15 writers killed at random moments; each reload is consistent and the version only rises |
| 3 | S1, S25, S36 and the `removeMedia` part of S22 pass; no open CRITICAL/HIGH | `test/paths.test.ts` "path rule (S1)" (`..`, `%2e%2e`, absolute, NUL, symlink escape); `test/history/lock.test.ts` "a lock from another host is never broken" (S25); `test/history/schema.test.ts` + `hardening.test.ts` (S36: no lock, log or write on `SCHEMA_TOO_NEW`, migration copy first); `test/ops/removeMedia.test.ts` (S22: file stays on disk); review table below |
| 4 | "Contracts frozen" milestone marked; R2 rows "02" say frozen | `plan/PROGRESS.md`, `plan/ref/R2-contracts.md` (8 rows "02, frozen 2026-10-11"), D-28 |

## Review findings
Reviews ran as agents (foreground): ecc:code-reviewer, ecc:typescript-reviewer,
ecc:type-design-analyzer, ecc:security-reviewer (S1, S25, S36, S22 `removeMedia`), then a second
ecc:code-reviewer pass on the fix commit.

| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| code-reviewer | HIGH | `snapDown` wrong at 23.976/29.97/59.94 | yes, test at all rates |
| code-reviewer | HIGH | recovery of a coalesced entry missed keys that returned to their start | yes (D-28) |
| security-reviewer | HIGH | lock: torn lock of a killed writer blocked 60 s; stale break could remove a fresh lock | yes: hard-linked lock with nonce, serialised break (D-28) |
| security-reviewer | HIGH | S36: lock taken before the schema check when another process made the project newer | yes |
| code-reviewer (2nd) | HIGH | two breakers could both remove locks (rename + put back race) | yes: `.project.lock.break` marker |
| code-reviewer | MEDIUM | a failing `release()` or listener overrode a committed result | yes |
| code-reviewer (2nd) | MEDIUM | a write that threw after the append came back as a recovered version | yes: line taken back |
| code-reviewer (2nd) | MEDIUM | external event lost when the op failed; schema-invalid complete line truncated as torn | yes |
| typescript-reviewer | MEDIUM | wildcard exports, `OpResult.error` as a class instance, strict history lines | yes (D-28) |
| type-design-analyzer | MEDIUM | override/sourceRange/speechRegions ranges and meta dates unchecked | yes (D-28) |
| security-reviewer | MEDIUM | symlinked project folder, id ≠ folder, `__proto__` keys in template switch, CLI control chars, `--actor external` | yes |
| code-reviewer | MEDIUM | stamp race in load; rotation failure after commit; log errors failing callers | yes |
| security-reviewer | LOW | temp files with fixed names; append follows symlinks | yes (`wx` + random suffix, `O_NOFOLLOW`) |
| code-reviewer (2nd) | LOW | release compares then unlinks (not atomic) after a 60 s hold | no: needs a 60 s live hold; noted |
| code-reviewer (2nd) | LOW | `link` unsupported on exFAT/SMB | no: projects on shared or non-APFS drives are unsupported (spec) |
| type-design-analyzer | LOW | load-time invariant check, `MediaItem` discriminated union, typed `OpArgs` map, `Engine.close()`, event `kind` | no: handoff |

## Deviations
- Ids use a per-millisecond counter that starts at a random value instead of 4 random digits, so ids
  made in the same millisecond sort by creation (D-28).
- Shifts (ripple, insert, `removePauses`) are computed in frame space, then converted to ms, so cuts
  stay on the grid at fractional rates.
- Ops infra (normalise, diff) and the CLI were written alongside their tests in small steps rather
  than strictly test first; every behaviour has a test.
- `OpResult.error` is `VoxErrorJson`; history lines are read loosely; lock content gains `nonce`;
  snapshot names `auto-*` reserved; spec edited (D-28).

## MANUAL STEPS
None.

## Handoff notes
- Phase 11: agent write tools come from `OP_ARGS` (one zod schema per op, exported by name) and
  `OP_NAMES`. Exclude `deleteProject` from the agent tools (S22). `ApplyResult` is plain JSON.
- Phase 03: `SequenceView.captions` is `[]` until `deriveCaptions`; reuse `mapWordsToTimeline` /
  `wordSourceTracks` from `ops/words.ts`. Templates plug in through `TemplateLookup`
  (`mapTemplateLookup`).
- Phase 04: call `computeWordKinds` after Whisper; apply job results with `{ jobId, baseVersion }`
  (`JOB_CONFLICT` skips the job's own earlier entries). Fill `EngineOptions.tools`; `vox paths` prints
  `tools: { dir }` until then. Plug the redactor into `EngineLog` (`redact` option).
- Phase 08: the `vox-media://` handler imports `@vox/engine/paths` only.
- Early packages (E1–E5, G1): append codes to `ERROR_CODES` after this merge; the `VoxError`
  constructor `(code, message, hint, { cause?, details? })` is unchanged.
- Test runner: `pnpm -C packages/engine test -- <filter>` runs `test/<filter>*`; CLI tests run with
  `pnpm exec vitest run packages/cli`. RTK: run prettier/eslint/tsc/pnpm through `rtk proxy` for real
  output (the hook can report success falsely).
- Deferred: load-time invariant check (overlaps, links) on open; `MediaItem` as a discriminated
  union; typed `OpArgs` map; `Engine.close()`; `ProjectChangedEvent.kind`; macOS `F_FULLFSYNC`
  (Node `fsync` is not a full flush on APFS: documented risk, not fixed).
