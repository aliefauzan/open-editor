# R2 — Contracts: where each one is defined and when it freezes

The specs define every contract. This file is an index, so a phase knows what it may change.
"Frozen" means: after that phase, a change needs a spec edit plus a DECISIONS entry in the same
commit, and every consumer updated in that commit.

| Contract | Defined in (spec § section) | Code home | Created | Frozen after |
|---|---|---|---|---|
| `project.json` schema, frame grid | engine "Data model" | `engine/src/model/` | 02 | 02 |
| Edit operations (names, args, rules; `setCaptions` override fields per D-11) | engine "Edit operations" | `engine/src/ops/` | 02 | 02 |
| `HistoryEntry`, undo cursor, `undoRun` | engine "History" | `engine/src/history/` | 02 | 02 |
| Path rule | engine "Project folder" | `engine/src/paths.ts` (subpath export `@vox/engine/paths`) | 02 | 02 |
| `VoxError { code, message, hint, cause? }` + codes | engine "Error handling", all specs | `engine/src/errors.ts` | 02 | grows; codes never renamed |
| Engine library API (`openEngine`, `Engine`) | engine "Library API" | `engine/src/api.ts` | 02 (grows 03–05) | 05 |
| Engine events (`project.changed`, `job.*`) | engine "Library API" | `engine/src/api.ts` | 02/04 | 05 |
| `style.json`, `template.json`, tokens `--tok-*` | styles "Part A" | `engine/src/styles/` | 03 | 06 |
| `vox.vars(el)` / `vox-runtime.js`, `data-vox-vars` | engine "Compile" | `engine/src/compile/` | 03 | 03 (styles add helpers in their own assets, e.g. `styles/vox/assets/motion.js`, never here) |
| Compile `BuildResult`, layer order | engine "Compile" | `engine/src/compile/` | 03 | 05 |
| `ImageProvider` | engine "Image generation provider" | `engine/src/api.ts` | 05 | 05 |
| Quick clips scorer (`engine.quickClips.registerScorer(id, fn)`: candidates with text and times → one score each) | engine "Quick clips" | `engine/src/stages/quickClips.ts` | 05 | 05 |
| Python tool request/response (stdin/stdout JSON, stderr progress) | engine "Repository layout" (Python bridge) | `engine/src/py.ts`, `py/vox_py/*` | 04 | per tool |
| CLI commands and `--json` output | engine "Stages"; styles "Style registry"; agent "CLI" | `packages/cli` | 02–05, 06, 12 | 05 (engine), 12 (agent) |
| `~/.vox/config.json` schema and file I/O | engine "Library API" (Config); agent "Configuration and keys" | `engine/src/config.ts`; key refs in `agent/src/config/` | 04 (`contact`, `projectsDir`), 11 (providers, roles, limits) | 11 |
| Secret redactor (`engine.redactor`) | engine "Library API" (Redactor); agent "Secret redactor" | `engine/src/redact.ts` | 04 | 11 |
| Agent tools (generated) | agent "Tools" | `agent/src/tools/` | 11 | follows ops |
| Agent events `agent.*`, run record | agent "Agent loop" | `agent/src/loop/` | 11 | 12 |
| `ClipPlan` (plan mode) | agent "Plan mode" | `agent/src/loop/plan.ts` | 11 | 12 |
| `window.vox` API (one zod schema) | app "Engine-host API" | `apps/desktop/src/shared/api.ts` | 08 | when 08 and 05 are both done (it wraps the engine API); grows 09–13 additively |
| Apple helper protocol (JSON lines: request `{system, messages, schema?, maxTokens, temperature}`, response `{text\|json, usage}`, `--status`) | agent "Apple on-device model" | `native/apple-llm/`, `agent/src/providers/apple.ts` | 11 | 11 |
| `vox-media://` URL shapes, CSPs | app "Window security", "Untrusted HTML" | `apps/desktop/src/main/protocols/` | 08 | 08 |
| `preview.updated { kind: 'patch' \| 'reload' }` | app "Preview pipeline" | engine-host | 08/10a | 10a |

## Error codes (collected from the specs)

`STALE`, `LOCKED`, `HISTORY_CORRUPT`, `UNDO_CONFLICT`, `TRACK_LOCKED`, `NO_HANDLES`, `MEDIA_MISSING`,
`TEMPLATE_VERSION`, `HOOK_UNTRUSTED`. Phases add codes as they need them (e.g. ingest, setup, provider
errors); each new code is added to `errors.ts` with a hint and listed in the phase log.

## Rule for changing a frozen contract

1. Edit the spec section. 2. Add a D-NN entry (why, what changes, who consumes it). 3. Update every
consumer and its tests in the same commit. 4. If the change touches `window.vox`, regenerate preload
types and run the IPC security tests.
