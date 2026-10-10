# Phase 02 — Engine: model, ops, history

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 00 (may run in parallel with 01) |
| Spec § | engine "Project folder", "Data model", "Edit operations", "History"; "Library API" (project + history methods) |
| Model | Opus 5.5 · high |
| Gate | — (contracts freeze at the end: `project.json` (incl. rational fps and the D-15 fields), transcript file, ops (incl. `removePauses`, `removeWords`), `HistoryEntry` (incl. `jobId`, `coalesceKey`, `replaces`), `ApplyResult`, `engine.view` / `SequenceView`, `SCHEMA_TOO_NEW`, path rule) |
| Next | 03, 04 |

## Goal

The single source of truth (`project.json`) with every edit operation, correct multi-level undo/redo,
per-run undo, and crash-safe, cross-process-safe writes. No rendering yet. After this phase, agent tools
and UI actions have a stable, tested target.

## Required reading

- Engine spec "Project folder" (path rule), "Data model" (frame grid, schema, track-kind rules),
  "Transcripts" (word kinds, D-15),
  "Captions" (only `CaptionTrack` shape and `setCaptions` here; `deriveCaptions` is phase 03),
  "Transitions" (`NO_HANDLES` rule), "Edit operations" (incl. `removePauses`, `removeWords`),
  "History" (all subsections, incl. "Coalescing" and the `ApplyResult` in "Write order"),
  "Library API" (`view`, `SequenceView`; job results only as far as `applyOp` checks `jobId`).
- `plan/ref/R2-contracts.md`, `R3-conventions.md`, `R4-security.md` rows S1, S25, S36.

## Output

- `engine/src/model/`: zod schemas + types for `Project`, `MediaItem`, `Sequence`, `Track`, `MediaClip`,
  `SceneClip`, `CaptionTrack`, `Transcript`; frame-grid helpers `ms(f)`, `frame(ms)`, `snap`;
  `normalise`/`denormalise`. D-15: `canvas.fps` is a rational `Fps { num, den }` from the fixed set
  (24/1, 25/1, 30/1, 60/1, 24000/1001, 30000/1001, 60000/1001; default 30/1),
  `ms(f) = Math.round(f * 1000 * den / num)`, `frame(ms) = Math.round(ms * num / (1000 * den))`;
  `inMs` snaps to the **source** grid (`MediaItem.fps`; media with no `fps` use the sequence grid).
  New fields: MediaItem `fps`, `vfr`, `cfrPath`, `loudness`, `shotsPath`; MediaClip `frame.mode: 'auto'`,
  `frame.stability`, `frame.trackSpeed`, `frame.keyframes` (`atMs` relative to the item start) and
  `denoise`; CaptionTrack `maxLines`, `maxCharsPerLine`, `gapFillMs`, `autoEmphasis`; override
  `emphasis`. All part of `schemaVersion: 2` (no migration, D-15).
- `engine/src/text/fillers.ts` + word kinds (D-15): filler lists per language; `computeWordKinds` marks
  `filler`, `repeat` (1–3-word n-gram repeated back to back; the earlier copy), `pause` pseudo-words
  (gap ≥ 350 ms, empty `text`, counted in `wordIndex`) and `word`. Phase 04 calls it after Whisper.
- `engine/src/ops/`: every op in the spec table, each `(project, args) => project` with a zod schema;
  `onOverlap` modes; linked behaviour; sync-lock ripple/insert; locked tracks; track-kind rules; `batch`;
  `removePauses` (with the optional `wordKeys` filter) and `removeWords` with `dryRun` (D-15), built on a
  word → timeline-range helper that phase 03's `deriveCaptions` reuses.
  Scene variable validation uses a template-schema lookup interface (stubbed with fixture schemas here;
  real registry in phase 03).
- `engine/src/history/`: change records, undo/redo cursor, `undoRun` with conflicts, write order with
  fsync, recovery on load, `O_EXCL` lockfile, rotation, snapshots, `restoreSnapshot` op. D-15: caption
  overrides as their own entities `captionOverride:<seqId>/<wordKey>` (`captions:<seqId>` holds track
  fields only); coalescing (`coalesceKey`, `replaces`); `jobId` on entries and the `JOB_CONFLICT` key
  check against the job's `baseVersion`; `ApplyResult { version, changes, results }`; `SCHEMA_TOO_NEW`
  on load and `snapshots/auto-pre-migrate-v<N>.json` before a migration.
- `engine/src/paths.ts`: the path rule, published as the subpath export `@vox/engine/paths`
  (`package.json` `exports`: `.` and `./paths`); `resolveProjectsDir({ flag?, env, config? })`
  (`--projects-dir` > `VOX_PROJECTS_DIR` > config `projectsDir` (wired in 04, when the config module
  exists) > `~/Movies/Vox Studio`), creating the folder with mode `0700` (D-10).
- `engine/src/errors.ts`: `VoxError` + codes `STALE`, `LOCKED`, `HISTORY_CORRUPT`, `UNDO_CONFLICT`,
  `TRACK_LOCKED`, `NO_HANDLES`, `SCHEMA_TOO_NEW`, `JOB_CONFLICT` (D-15), validation codes.
- `engine/src/api.ts`: `openEngine({ projectsDir, stylesDirs, tools? })` with `listProjects`,
  `createProject`, `getProject`, `deleteProject`, `applyOp` (opts `{ actor, runId?, baseVersion?,
  coalesceKey?, jobId? }` → `ApplyResult`), `view(projectId, sequenceId)` → `SequenceView` (D-15),
  `undo`, `redo`, `undoRun`, `history`, `snapshot`, `listSnapshots`, `on('project.changed')`.
- `packages/cli`: `vox new`, `vox op`, `vox undo`, `vox redo`, `vox history`, `vox snapshot`, `vox paths`
  (all `--json`; every command takes `--projects-dir`). `vox new` sets `styleId: 'base'` until the style
  registry exists (phase 03 switches it to `vox` if installed).

## Steps

### A. Model

1. [ ] Frame grid: property test — for every rate in the fixed set (incl. 24000/1001, 30000/1001,
       60000/1001), `frame(ms(f)) === f` for every frame of 10 hours (D-15). `inMs` snapping: a 29.97
       source in a 30 fps sequence keeps `inMs` on the source grid after trims and splits.
2. [ ] Schemas + `schemaVersion: 2`; ids prefixed per R3 (track ids stay `V1..Vn`/`A1..An`); load
       rejects unknown fields, so a new field always comes with a `schemaVersion` bump and a load-time
       migration (14e adds `speed` this way).
3. [ ] `normalise`/`denormalise` round-trip test on fixture projects (items re-sorted by `startMs`,
       caption overrides by `wordKey`).
3a. [ ] Word kinds (D-15): `computeWordKinds` on fixture word lists and on the hand-written
       `transcripts/speech-fillers.json` (R7): fillers per language, 1–3-word repeats (earlier copy
       marked), pauses ≥ 350 ms as pseudo-words with a `wordKey`; a 300 ms gap is no pause.

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
       `pasteItems`, `batch` (atomic). `updateScene { sfxOff }` (D-14): names must be cues the scene's
       template declares (checked once the registry exists in 03; here against the stub metadata).
6a. [ ] `setCaptions` override `emphasis` (D-15) and the new CaptionTrack fields with their defaults
       (`maxLines` 1, `maxCharsPerLine` 18, `gapFillMs` 400, `autoEmphasis` false). `frame` fields
       (`auto`, `stability`, `trackSpeed`, `keyframes`) and `denoise` validate; keyframes keep their
       relative `atMs` on `moveItem` and shift on a start trim.
6b. [ ] `removePauses { sequenceId, minPauseMs = 350, keepMs = 80, kinds = ['pause'], wordKeys? }` and
       `removeWords { sequenceId, wordKeys[] }` (D-15), tested on a project built from
       `transcripts/speech-fillers.json`: words found as `deriveCaptions` finds them (caption source
       tracks, `A1` when captions are off); pause ranges keep `keepMs` (half at each edge); pauses under
       `minPauseMs` kept; ranges snapped and merged; one `batch` of `rippleDelete` ranges (latest
       first) over linked V and A items = one undo entry; `kinds` with `filler` and `repeat`;
       `dryRun: true` returns `{ startMs, endMs, kind, wordKeys }[]` and leaves version and history
       unchanged; `wordKeys` set to a subset of the dry-run keys removes only those ranges, each still
       keeping `keepMs` (half at each edge), and the unlisted ranges stay.
7. [ ] Rule tests: overlap modes; insert/ripple across sync-locked tracks; locked track rejects shifts
       (`TRACK_LOCKED` names it); media duration bound; track-kind rules; 100 random splits leave no
       1-frame gaps at every rate in the fixed set.

### C. History

8. [ ] Change records: diff of normalised before/after; `before: null` create, `after: null` delete.
       Caption overrides are `captionOverride:<seqId>/<wordKey>` entities: a word edit records one
       small entity, and `undoRun` conflicts on captions are per word (D-15).
9. [ ] Undo/redo cursor incl. redo after `undoRun` (several targets), redo cleared by a new op, depth 500,
       cursor rebuilt on load. Test: N random ops, undo all, redo all → exact project each step.
10. [ ] `undoRun` with and without conflicts; conflict lists keys and item ids; changes nothing on conflict.
10a. [ ] Coalescing (D-15): ten ops with one `coalesceKey` within 1 s → one undo entry that restores the
        first `before`; the log stays append-only (`replaces`); a different key, actor or `runId`, an entry
        in between, or a gap over 1 s → separate entries.
10b. [ ] `ApplyResult` (D-15): `results` has one entry per op (per op inside a `batch`) with
        `succeeded` / `failed` / `conflicted` and touched `items`; a batch with one rejected op applies
        nothing (version unchanged, `changes` empty). `jobId` + `baseVersion`: an entry after
        `baseVersion` that touched a key the batch touches → `JOB_CONFLICT` listing the keys, nothing
        applied; an unrelated entry → applies.
11. [ ] `applyOp` write order (lock → external-change check → `STALE` → op → history append + fsync →
        temp + fsync + rename + dir fsync → unlock → event).
11a. [ ] Schema safety (D-15): a project with a newer `schemaVersion` fails `SCHEMA_TOO_NEW` and its folder
        is byte-identical afterwards (no lock, log or snapshot); a load-time migration (test with a
        fake v1 → v2 step) writes `snapshots/auto-pre-migrate-v1.json` first (S36).
12. [ ] Recovery: kill between history append and project write (child-process test, both orders); torn
        last line truncated; version+1 entry re-applied without new line or version bump; other gaps →
        `HISTORY_CORRUPT`.
13. [ ] Lockfile: dead pid on same host → broken; other host → never broken, `LOCKED` after 5 s; >60 s
        same host → broken.
14. [ ] Rotation at 5,000 entries + snapshot; `snapshot`/`restoreSnapshot` (one undoable entry).
14b. [ ] Engine log (engine spec "Project folder", D-16): `engine/src/log.ts` appends lines to
        `logs/engine.log`, rotated at 5 MB with 3 files kept (`engine.log`, `.1`, `.2`). Test: write past
        5 MB twice → 3 files, oldest dropped, no line lost or split across files; secrets pass through the
        redactor once it exists (04).
14a. [ ] `view` (D-15): snapshot test of the `SequenceView` for a fixture sequence (flat `items[]` with
        `id`, `track`, `startMs`, `endMs`, `kind`, `mediaId` or `template`/`text`; `version`). Caption
        chunk text stays empty until phase 03 plugs in `deriveCaptions`.

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

- [ ] Every op and rule above has passing tests at every rate in the fixed set (incl. 23.976, 29.97 and
      59.94; D-15).
- [ ] Engine done-when #6 (killing `vox op` mid-write never loses or corrupts a project) is proven by
      the recovery test.
- [ ] S1, S25, S36 and the `removeMedia` part of S22 pass; security review has no open CRITICAL/HIGH.
- [ ] PROGRESS "Contracts frozen" milestone marked; R2 rows for this phase say frozen.

## Risks and fallback

| Risk | Fallback |
|---|---|
| fsync on APFS slower than expected for drags | Drags send one op on drop; sliders and text fields coalesce with `coalesceKey` (D-15), so history stays one entry per gesture; measure `applyOp` p95 and log it |
| Template schema lookup needed before the registry exists | Interface + fixture schemas now; phase 03 plugs the registry in |

## Handoff notes

- Phase 11 generates agent write tools from these op schemas: keep each schema exported by name.
- Phase 03 fills `SequenceView.captions` from `deriveCaptions` and reuses the word → range helper.
- Phase 04 calls `computeWordKinds` after Whisper and applies job results with `jobId` (D-15).
- Phase 08's `vox-media://` handler imports `@vox/engine/paths` (never the engine main entry).
