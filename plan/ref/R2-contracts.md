# R2 — Contracts: where each one is defined and when it freezes

The specs define every contract. This file is an index, so a phase knows what it may change.
"Frozen" means: after that phase, a change needs a spec edit plus a DECISIONS entry in the same
commit, and every consumer updated in that commit.

| Contract | Defined in (spec § section) | Code home | Created | Frozen after |
|---|---|---|---|---|
| `project.json` schema, frame grid (rational `Fps { num, den }` from the fixed set; `inMs` on the source grid; D-15 fields: MediaItem `fps`/`vfr`/`cfrPath`/`loudness`/`shotsPath`, `frame` `auto`/`stability`/`trackSpeed`/`keyframes`, `denoise`, CaptionTrack `maxLines`/`maxCharsPerLine`/`gapFillMs`/`autoEmphasis`, override `emphasis`) | engine "Data model" | `engine/src/model/` | 02 | 02, frozen 2026-10-11 |
| Transcript file (`transcripts/<id>.json`: words with `kind`, pause pseudo-words, `speechRegions`; D-15) | engine "Transcripts" | `engine/src/model/`, `engine/src/text/fillers.ts` | 02 (04 writes it) | 02, frozen 2026-10-11 |
| Edit operations (names, args, rules; `setCaptions` override fields per D-11, `emphasis` per D-15; `removePauses`, `removeWords` with `dryRun`, D-15) | engine "Edit operations" | `engine/src/ops/` | 02 | 02, frozen 2026-10-11 |
| `HistoryEntry` (incl. `jobId`, `coalesceKey`, `replaces`; D-15), entity keys (incl. `captionOverride:<seqId>/<wordKey>`), coalescing, undo cursor, `undoRun` | engine "History" | `engine/src/history/` | 02 | 02, frozen 2026-10-11 |
| `applyOp` result `ApplyResult { version, changes, results }` (per-op `succeeded`/`failed`/`conflicted`, touched `items`; D-15) | engine "Write order", "Library API" | `engine/src/history/`, `engine/src/api.ts` | 02 | 02, frozen 2026-10-11 |
| `engine.view` / `SequenceView` (compact read for the agent; D-15) | engine "Library API" | `engine/src/api.ts` | 02 | 02, frozen 2026-10-11 |
| Load safety: `SCHEMA_TOO_NEW`, `snapshots/auto-pre-migrate-v<N>.json` (D-15) | engine "Write order, crash recovery, locking" | `engine/src/history/` | 02 | 02, frozen 2026-10-11 |
| Path rule | engine "Project folder" | `engine/src/paths.ts` (subpath export `@vox/engine/paths`) | 02 | 02, frozen 2026-10-11 |
| `VoxError { code, message, hint, cause? }` + codes | engine "Error handling", all specs | `engine/src/errors.ts` | 02 | grows; codes never renamed |
| Engine library API (`openEngine`, `Engine`) | engine "Library API" | `engine/src/api.ts` | 02 (grows 03–05) | 05, frozen 2026-10-11 |
| Engine events (`project.changed`, `job.*`) | engine "Library API" | `engine/src/api.ts` | 02/04 | 05, frozen 2026-10-11 |
| `style.json`, `template.json`, tokens `--tok-*` (incl. `sfx` object form `{path, type, source, licence}` and `sfxCues` with `name` and `type`, D-14; `minEntranceMs` and the reserved `skipEntrance` variable, D-15) | styles "Part A", "SFX rules" | `engine/src/styles/` | 03 | 06, frozen 2026-10-11 |
| Caption preset `captions/<preset>.json` (`case`, `stripPunctuation`, `safeArea`, `position`) the read/active/unread word-state contract (D-15) and word `data-key` (D-34) | styles "Caption presets" | `engine/src/styles/`, `engine/src/compile/` | 03 | 06, frozen 2026-10-11 |
| `CaptionChunk` / `CaptionWord` (lines, word times, `emphasis`; D-15) | engine "Captions" | `engine/src/model/` (`deriveCaptions`) | 03 | 03 |
| Cue list `build/<seq>/audio/cues.json` (kept and dropped cues with reasons) | engine "Sound cues" | `engine/src/audio/cues.ts` | 03 | 05, frozen 2026-10-11 |
| Audio QA output (`qa.json`, `qa.png`, `LISTEN.md`; thresholds in `audioqa_thresholds.json`) | engine "Audio QA" | `py/vox_py/audioqa.py`, job `audioQa` | 05 | 05, frozen 2026-10-11 (thresholds never loosened, R3) |
| Export target (`{file}` or `{dir}`; app `targetId` from `exports.chooseTarget`) | engine "Export targets"; app "Engine-host API" | `engine/src/export/target.ts`, `apps/desktop/src/main/` | 05 | 10b |
| Ingest URL classes (`youtube`, `instagram`, `tiktok`, `other`, `invalid`) | engine "Ingest sources" | `engine/src/stages/sources.ts` | 04 | 05, frozen 2026-10-11 |
| Shot list `shots/<id>.json` (`{ startMs, endMs }[]`), facetrack detections and crop keyframes `{ atMs, x, y, scale }` with cache key (D-15) | engine "Shots and framing" | `engine/src/stages/shots.ts`, `engine/src/stages/facetrack.ts`, `py/vox_py/facetrack.py` | 04 | 05, frozen 2026-10-11 |
| Job results: `baseVersion` at start, one `batch` with `jobId`, `JOB_CONFLICT` (D-15) | engine "Library API" (Job results), "Write order" | `engine/src/history/` (`jobId` check), `engine/src/jobs.ts` | 02 (`applyOp` side), 04 (runner) | 05, frozen 2026-10-11 |
| `vox.vars(el)` / `vox-runtime.js`, `data-vox-vars` | engine "Compile" | `engine/src/compile/` | 03 | 03 (styles add helpers in their own assets, e.g. `styles/vox/assets/motion.js`, never here) |
| Compile `BuildResult`, layer order | engine "Compile" | `engine/src/compile/` | 03 | 05, frozen 2026-10-11 |
| `ImageProvider` | engine "Image generation provider" | `engine/src/api.ts` | 05 | 05, frozen 2026-10-11 |
| Quick clips scorer (`engine.quickClips.registerScorer(id, fn)`: candidates with text and times, plus `prompt?` (D-15) → one score each) | engine "Quick clips" | `engine/src/stages/quickClips.ts` | 05 | 05, frozen 2026-10-11 |
| Python tool request/response (stdin/stdout JSON, stderr progress) | engine "Repository layout" (Python bridge) | `engine/src/py.ts`, `py/vox_py/*` | 04 | per tool |
| CLI commands and `--json` output | engine "Stages"; styles "Style registry"; agent "CLI" | `packages/cli` | 02–05, 06, 12 | 05 (engine, frozen 2026-10-11), 12 (agent) |
| `~/.vox/config.json` schema and file I/O | engine "Library API" (Config); agent "Configuration and keys" | `engine/src/config.ts`; key refs in `agent/src/config/` | 04 (`contact`, `projectsDir`, `ingest.cookiesFromBrowser`), 11 (providers, roles, limits) | 11 |
| Secret redactor (`engine.redactor`) | engine "Library API" (Redactor); agent "Secret redactor" | `engine/src/redact.ts` | 04 | 11 |
| Agent tools (generated) | agent "Tools" | `agent/src/tools/` | 11 | follows ops |
| Workflow frontmatter (`allowedTools`, `roles`, `checkpoints`; D-15) | agent "Workflows" | `agent/workflows/*.md`, read by `agent/src/loop/` | 11 (loop reads it), 12 (workflow files) | 12 |
| Agent events `agent.*`, run record | agent "Agent loop" | `agent/src/loop/` | 11 | 12 |
| `ClipPlan` (plan mode) | agent "Plan mode" | `agent/src/loop/plan.ts` | 11 | 12 |
| `window.vox` API (one zod schema; 10b adds `exports.chooseTarget`, `exports.lastFolder`, `media.classifyUrl`, D-13) | app "Engine-host API" | `apps/desktop/src/shared/api.ts` | 08 | 08 and 05, frozen 2026-10-11 (it wraps the engine API); grows 09–13 additively |
| Apple helper protocol (JSON lines: request `{system, messages, schema?, maxTokens, temperature}`, response `{text\|json, usage}`, `--status`) | agent "Apple on-device model" | `native/apple-llm/`, `agent/src/providers/apple.ts` | 11 | 11 |
| `vox-media://` URL shapes, CSPs | app "Window security", "Untrusted HTML" | `apps/desktop/src/main/protocols/` | 08 | 08 |
| `preview.updated { kind: 'patch' \| 'reload' }` | app "Preview pipeline" | engine-host | 08/10a | 10a |

## Error codes (collected from the specs)

`STALE`, `LOCKED`, `HISTORY_CORRUPT`, `UNDO_CONFLICT`, `TRACK_LOCKED`, `NO_HANDLES`, `MEDIA_MISSING`,
`TEMPLATE_VERSION`, `HOOK_UNTRUSTED`, `LOGIN_REQUIRED` (04, D-13), `EXPORT_PATH` (05, D-13), `SCHEMA_TOO_NEW` (02, D-15),
`JOB_CONFLICT` (02/04, D-15), `UNKNOWN_ALIAS` (agent, 11, D-15). Phases add codes as they need them (e.g. ingest, setup, provider
errors); each new code is added to `errors.ts` with a hint and listed in the phase log.

## Rule for changing a frozen contract

1. Edit the spec section. 2. Add a D-NN entry (why, what changes, who consumes it). 3. Update every
consumer and its tests in the same commit. 4. If the change touches `window.vox`, regenerate preload
types and run the IPC security tests.
