# Phase 02 — Engine: model, ops, history

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 00 (may run in parallel with 01) |
| Spec § | engine "Project folder", "Data model", "Edit operations", "History"; "Library API" (project + history methods) |
| Model | Opus 5.5 · high |
| Gate | — (contracts freeze at the end: `project.json`, ops, `HistoryEntry`, path rule) |
| Next | 03, 04 |

## Goal

The single source of truth (`project.json`) with every edit operation, correct multi-level undo/redo,
per-run undo, and crash-safe, cross-process-safe writes. No rendering yet. After this phase, agent tools
and UI actions have a stable, tested target.

## Required reading

- Engine spec "Project folder" (path rule), "Data model" (frame grid, schema, track-kind rules),
  "Captions" (only `CaptionTrack` shape and `setCaptions` here; `deriveCaptions` is phase 03),
  "Transitions" (`NO_HANDLES` rule), "Edit operations", "History" (all subsections).
- `plan/ref/R2-contracts.md`, `R3-conventions.md`, `R4-security.md` rows S1, S25.

## Output

- `engine/src/model/`: zod schemas + types for `Project`, `MediaItem`, `Sequence`, `Track`, `MediaClip`,
  `SceneClip`, `CaptionTrack`; frame-grid helpers `ms(f)`, `frame(ms)`, `snap`; `normalise`/`denormalise`.
- `engine/src/ops/`: every op in the spec table, each `(project, args) => project` with a zod schema;
  `onOverlap` modes; linked behaviour; sync-lock ripple/insert; locked tracks; track-kind rules; `batch`.
  Scene variable validation uses a template-schema lookup interface (stubbed with fixture schemas here;
  real registry in phase 03).
- `engine/src/history/`: change records, undo/redo cursor, `undoRun` with conflicts, write order with
  fsync, recovery on load, `O_EXCL` lockfile, rotation, snapshots, `restoreSnapshot` op.
- `engine/src/paths.ts`: the path rule, published as the subpath export `@vox/engine/paths`
  (`package.json` `exports`: `.` and `./paths`); `resolveProjectsDir({ flag?, env, config? })`
  (`--projects-dir` > `VOX_PROJECTS_DIR` > config `projectsDir` (wired in 04, when the config module
  exists) > `~/Movies/Vox Studio`), creating the folder with mode `0700` (D-10).
- `engine/src/errors.ts`: `VoxError` + codes `STALE`, `LOCKED`, `HISTORY_CORRUPT`, `UNDO_CONFLICT`,
  `TRACK_LOCKED`, `NO_HANDLES`, validation codes.
- `engine/src/api.ts`: `openEngine({ projectsDir, stylesDirs, tools? })` with `listProjects`,
  `createProject`, `getProject`, `deleteProject`, `applyOp`, `undo`, `redo`, `undoRun`, `history`,
  `snapshot`, `listSnapshots`, `on('project.changed')`.
- `packages/cli`: `vox new`, `vox op`, `vox undo`, `vox redo`, `vox history`, `vox snapshot`, `vox paths`
  (all `--json`; every command takes `--projects-dir`). `vox new` sets `styleId: 'base'` until the style
  registry exists (phase 03 switches it to `vox` if installed).

## Steps

### A. Model

1. [ ] Frame grid: property test — for fps 24/25/30/60, `frame(ms(f)) === f` for f in 0..10^6.
2. [ ] Schemas + `schemaVersion: 2`; ids prefixed per R3 (track ids stay `V1..Vn`/`A1..An`); load
       rejects unknown fields, so a new field always comes with a `schemaVersion` bump and a load-time
       migration (14e adds `speed` this way).
3. [ ] `normalise`/`denormalise` round-trip test on fixture projects (items re-sorted by `startMs`).

### B. Operations (one test file per op)

4. [ ] Library ops: `addMedia`, `updateMedia`, `removeMedia` (fails if used; removes the library entry
       only, and a test checks the file is still on disk, S22), `replaceMedia` (same kind, clamps and reports).
5. [ ] Sequence and track ops, incl. fps change re-snapping all items in one entry.
6. [ ] `placeClip` (with `withAudio` linked pair on `A1`), `addScene`, `updateScene` (template switch
       when compatible per the engine spec ops table: same JSON-Schema type for every required target
       variable, slot kinds matched by key, undeclared variables dropped and listed; tests for each), `moveItem`, `trimItem`, `splitItem`, `removeItem`, `rippleDelete`,
       `link`/`unlink`, `setTransition` (`NO_HANDLES` for blending transitions), `setCaptions` (overrides
       `{ wordKey, text?, breakAfter?, startMs?, endMs? }`, D-11: `text` may hold several words or `null`;
       `startMs < endMs`, both inside the media; removing an override resets the word; one test per field),
       `pasteItems`, `batch` (atomic).
7. [ ] Rule tests: overlap modes; insert/ripple across sync-locked tracks; locked track rejects shifts
       (`TRACK_LOCKED` names it); media duration bound; track-kind rules; 100 random splits leave no
       1-frame gaps at every fps.

### C. History

8. [ ] Change records: diff of normalised before/after; `before: null` create, `after: null` delete.
9. [ ] Undo/redo cursor incl. redo after `undoRun` (several targets), redo cleared by a new op, depth 500,
       cursor rebuilt on load. Test: N random ops, undo all, redo all → exact project each step.
10. [ ] `undoRun` with and without conflicts; conflict lists keys and item ids; changes nothing on conflict.
11. [ ] `applyOp` write order (lock → external-change check → `STALE` → op → history append + fsync →
        temp + fsync + rename + dir fsync → unlock → event).
12. [ ] Recovery: kill between history append and project write (child-process test, both orders); torn
        last line truncated; version+1 entry re-applied without new line or version bump; other gaps →
        `HISTORY_CORRUPT`.
13. [ ] Lockfile: dead pid on same host → broken; other host → never broken, `LOCKED` after 5 s; >60 s
        same host → broken.
14. [ ] Rotation at 5,000 entries + snapshot; `snapshot`/`restoreSnapshot` (one undoable entry).

### D. Path rule and CLI

15. [ ] Path rule tests: `..`, `%2e%2e`, double-encoded, absolute, NUL, symlink escape (S1).
        Projects-folder tests: resolution order flag > env > default, folder created with mode `0700`,
        `vox paths --json` prints it (tests always use a temp folder, never the real default).
16. [ ] CLI commands with `--json`; `vox op` exit code 1 + hint on `VoxError`; `<project>` resolves an id
        or a unique name (ambiguous name → error listing the ids); `vox undo <project>`, `vox redo <project>`.

## Verify

```bash
pnpm -C packages/engine test
pnpm -C packages/engine test -- --run history/recovery     # includes the kill tests
export VOX_PROJECTS_DIR="$(mktemp -d)"                   # never touch ~/Movies/Vox Studio in verify
ID=$(pnpm -s -C packages/cli exec vox new demo --json | jq -r .id)
pnpm -C packages/cli exec vox history "$ID" --json
pnpm -C packages/cli exec vox paths --json | jq -e --arg d "$VOX_PROJECTS_DIR" '.projectsDir == $d'
```

## Done when

- [ ] Every op and rule above has passing tests at 24/25/30/60 fps.
- [ ] Engine done-when #6 (killing `vox op` mid-write never loses or corrupts a project) is proven by
      the recovery test.
- [ ] S1, S25 and the `removeMedia` part of S22 pass; security review has no open CRITICAL/HIGH.
- [ ] PROGRESS "Contracts frozen" milestone marked; R2 rows for this phase say frozen.

## Risks and fallback

| Risk | Fallback |
|---|---|
| fsync on APFS slower than expected for drags | Coalescing is the app's job (150 ms during drags); measure `applyOp` p95 and log it |
| Template schema lookup needed before the registry exists | Interface + fixture schemas now; phase 03 plugs the registry in |

## Handoff notes

- Phase 11 generates agent write tools from these op schemas: keep each schema exported by name.
- Phase 08's `vox-media://` handler imports `@vox/engine/paths` (never the engine main entry).
