# Phase 11 — Agent core

| Field | Value |
|---|---|
| Status | [x] merged 2026-10-11 19:22; live probe deferred to phase 13 step 7b (D-44) |
| Started · Finished | 2026-10-11 17:03 · 2026-10-11 19:22 |
| Model | Opus 5.5 · high |
| Machine | M5, macOS 27.0.1, Node 24.14.0, pnpm 12.0.0, Swift 6.4 |
| Branch | phase/11-agent-core (worktree `.worktrees/phase-11`) |

## Pre-check
Prerequisite 05 is [x] (GATE 2 passed, D-39). Early packages N1, G1, G2 (below) are merged; this run
skips their steps and wires them in. Phase 09 runs in parallel in `.worktrees/phase-09`. No provider
keys exist yet: live probes are a MANUAL STEP; tests use `MockLanguageModelV4` and the R4 canary key.

## Plan summary
1. Swap the `UtilError` shim for `VoxError`; append the agent error codes to the engine's `ERROR_CODES`.
2. `config/store.ts`: provider entries, roles, limits and user prices through `readConfig`/`writeConfig`;
   Keychain writes via `security -i`; masked = unchanged; keys registered with the redactor.
3. `tools/`: alias table, tool registry (read, one write tool per op, job tools, `check_audio`,
   `undo_my_last_edit`, `update_todos`, `describe_tool`, `call_tool`), frame health, transcript pages.
4. `loop/`: one `streamText` call per model step under our own step loop (fresh view + change note,
   compaction with version stubs, budget bound, call repair, identical-call guard, error mapping and
   retries, sub-runs, run record, events, restart), plan mode (`ClipPlan`, op-list plans, executor).
5. Replay harness; probe runner (`ClipPlan` plan task, largest tool list); `vox config` CLI.
Test order: 1, 2, 3, 15, 4, 18, 14, 12b, 5, 6, 19, 7, 8, 16, 13, 17, 9, 10, 11, 12, 20, CLI.

## Checklist
- [x] Steps 1–20 (+12b), tests first, all with `MockLanguageModelV4` and the R4 canary key.
- [x] `vox config providers add|list|remove`, `roles set`, `prices set`, `probe` (`packages/cli`).
- [x] Verify after `git merge main` (all green, below).
- [x] Review: self-review (token budget).
- [x] MANUAL STEP 1 (owner keys, live probe) — deferred to phase 13 step 7b by the owner (D-44): keys go in through the Settings screen. Merged on mock, replay and Apple on-device evidence.

## Files created / changed
55 files on `phase/11-agent-core` (+8,109 / −53 against main).
- `packages/agent/src/config/store.ts` (provider entries, roles, limits, prices through the engine
  config module), `errors.ts` (VoxError re-export; the `UtilError` shim is gone).
- `packages/agent/src/tools/`: `registry.ts`, `read.ts`, `ops.ts`, `jobs.ts`, `aliases.ts`,
  `transcript.ts`, `health.ts`, `sources.ts`, `types.ts`.
- `packages/agent/src/loop/`: `run.ts`, `plan.ts`, `conversation.ts`, `prompt.ts`,
  `provider-errors.ts`, `record.ts`, `types.ts`.
- `packages/agent/src/providers/run-probe.ts`; `api.ts` exports config, providers, tools and loop.
- `packages/cli/src/config.ts` + `main.ts` wiring (hidden key prompt, `config` options).
- `packages/engine/src/history/store.ts` (`UndoOptions.last`), `errors.ts` (agent codes).
- Tests: `packages/agent/test/{config,tools,loop,providers,replay}/…`, fixture
  `test/fixtures/transcripts/injection.json` (S20), `packages/cli/test/config.test.ts`,
  `packages/engine/test/{api,errors}.test.ts`.

## Verify results
Run in the worktree after `git merge main` (phase 09 and the 10a plan commit merged in; one conflict in
`packages/cli/src/main.ts` `Io`, both sides kept).

| Command | Result | Numbers |
|---|---|---|
| `pnpm typecheck` | pass | 0 errors |
| `pnpm lint` (eslint + prettier) | pass | clean |
| `pnpm test` | pass | 166 files, 2226 passed, 1 skipped. One earlier full run (before the last commit) exited 1 without a captured failure; the two runs after it passed. |
| `pnpm -C packages/agent test` | pass | 30 files, 620 passed, 1 skipped |
| `swift build -c release --package-path native/apple-llm` | pass | build complete (macOS 27 SDK) |
| Apple tests (local tier: `apple.local`, `apple-helper.local`, `apple`, `apple-protocol`) | pass | 4 files, 107 passed, 1 skipped ("a request gets `unavailable` when the model is not ready": the model is ready) |
| `pnpm -C packages/agent test:slow -- apple` | n/a | the agent has no `*.slow.test.ts`; the Apple tests are the `*.local` tier (D-16), run above |
| `vox config probe` with the real Apple helper (temp `VOX_HOME`) | pass | `apple ready`, `context 8192 (apple)`, `plan pass` (3 of 3 runs after the `ClipPlan` fix); `roles set fast apple:apple-on-device` exit 0; `roles set vision` exit 1 (`apple failed`) |
| `pnpm -C packages/cli exec vox config probe --json` with the owner's keys | not run | MANUAL STEP 1 |

The first real Apple probe failed `plan`: the on-device model (guided generation) filled every field and
sent `template: ""` on a speaker beat. A test now covers that answer and `ClipPlan` accepts an empty
template on speaker beats (scene beats still need one); see D-43.

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | S17–S24, S30, agent part of S32, phase-11 parts of S34/S35 pass; review clean of CRITICAL/HIGH | S17 `config/store.test.ts`, `mask.test.ts`; S18 store masked = unchanged; S19 `loop/redaction.test.ts` + `cli/test/config.test.ts` (canary absent, provider answer redacted); S20 `loop/injection.test.ts`, `tools/jobs.test.ts`; S21 envelope tests; S22 `tools/registry.test.ts` snapshot (no shell/file/http tool, no output path); S23 `loop/run.test.ts` upper-bound pause, `maxOutputTokens` set; S24 `undo_my_last_edit` cannot undo a user edit; S30 `config/keychain.spawn.test.ts`; S34 vision wrapping + on-image text test; S35 `call_tool` rules, question turn. Self-review below. |
| 2 | Apple provider passes against the fake helper; on the M5 the real helper reports `ready` and `vox config probe` shows its capabilities | fake helper: `apple.test.ts`, `run-probe.test.ts`; real: `--status` → `{"status":"ready","contextSize":8192}`, probe output in Verify |
| 3 | MANUAL STEP (owner): OpenRouter key + Ollama model, `vox config probe` reports tools, loop, vision, context | open: MANUAL STEP 1 |
| 4 | D-15 runtime tests (steps 14–20) pass, incl. the on-image text test (S34) | `loop/run.test.ts`, `replay/replay.test.ts`, `providers/run-probe.test.ts` |
| 5 | R5 AI SDK and provider pins filled | R5 rows `ai` 7.0.137, providers (early G2) |

## Review findings
Self-review (token budget): no subagents; one pass over the branch diff with the R4 rows, plus code,
TypeScript, Swift (no Swift change this run) and silent-failure checks. No CRITICAL or HIGH.
- Fixed: `--key` accepted any string, so a literal key would land in shell history: now only
  `env:NAME`; a key is typed at a hidden prompt (S17, S30).
- Fixed: errors leaving `vox config` (a provider answer can quote the key) are redacted (S19).
- Fixed: `ClipPlan` rejected the Apple model's empty speaker template (found by the real probe).
- Note: the hidden prompt reads raw stdin only when stdin is a TTY; `--json` or a pipe needs `--key`.
- Note: `vox config probe` exits 1 when any named model could not be probed (missing key, unknown
  provider); failed checks alone exit 0 (they are the report).

## Deviations
- Engine API (frozen after 02): additive `UndoOptions.last` and agent error codes; spec edit + D-43.
- The agent has no `test:slow` script: the Apple tests are the local tier (D-16), not VOX_SLOW.

## MANUAL STEPS
1. (required) Add an OpenRouter key and one Ollama model, then probe both:
   `vox config providers add openrouter` (type the key at the hidden prompt, or
   `--key env:OPENROUTER_API_KEY`); `vox config providers add ollama` (Ollama running with one model
   pulled); `pnpm -C packages/cli exec vox config probe --json openrouter:<model-id> ollama:<model>`.
   Expected: tools, loop, vision and context reported for both (agent done-when #1). Paste the
   output (keys are masked) into this log, or tell the AI to run the probe.
2. (optional — does not block merge) Add any of `claude`, `opencode-zen`, `9router` the same way and
   probe them.

## Handoff notes
- Phase 12: agent job writes (ingest, transcribe, assets) carry `actor: agent` but no `runId`, so
  `undoRun` does not undo them (D-43); decide whether jobs started by a run record its `runId`.
- Phase 12: record workflow runs with `RunRecord` and replay them with `test/replay/harness.ts`.
- Phase 13: import from `@vox/agent` only (`api.ts`); `runAgent`, `AgentRun`, events in
  `loop/types.ts`; settings use `saveProvider`/`maskedProviders`/`setRole` + `roleCheck`.
- Packaging: the `.app` should ship the helper at `Resources/bin/vox-apple-llm`; the CLI looks there
  (or `VOX_APPLE_LLM`).

## Early steps (D-19) — n1-apple-llm

Package N1 (Apple on-device helper). Branch `early/n1-apple-llm`, **merged to main** (merge commit
280d139, pushed; worktree removed). Verify in the worktree after merging main: `pnpm typecheck`,
`pnpm lint`, `pnpm test` all green (10 files, 198 passed, 1 skipped), `uv run --project py pytest`
58 passed (after `make.sh` built the fixtures). Protocol details: D-22.

**Steps done**: the helper half of step 12 and the Output items `native/apple-llm/`,
`fake-apple-llm.mjs` and the protocol schemas. The provider itself is not started.

**Files**
- `native/apple-llm/`: Swift Package (tools 6.0, `.macOS(.v14)`). `AppleLLMCore` (pure Swift: strict
  JSON parser/encoder, request parsing and validation, JSON Schema → `SchemaNode` subset, line
  encoders, token estimate), `vox-apple-llm` (executable: `--status`, JSON-lines serve loop,
  `#available(macOS 26, *)` around every Foundation Models call, `DynamicGenerationSchema` guided
  generation, error mapping; FoundationModels weak-linked), `AppleLLMCoreTests` (Swift Testing).
- `packages/agent/src/providers/apple-protocol.ts`: zod schemas (`AppleStatus`, `AppleRequest`,
  `AppleResponse`, …), `encodeAppleRequest`, `parseAppleResponseLine`, `parseAppleStatusLine`,
  `JsonLineSplitter` (split on `\n` only; `apple.ts` must use it, not `node:readline`).
- `packages/agent/test/fixtures/fake-apple-llm.mjs`: same protocol; env `VOX_FAKE_APPLE_STATUS`,
  `VOX_FAKE_APPLE_CONTEXT`, `VOX_FAKE_APPLE_ANSWERS` (`text`, `json`, `error`, `crash`, `hang`,
  plus `delayMs`, `usage`), `VOX_FAKE_APPLE_LOG`. Header comment documents it.
- `packages/agent/test/helpers/apple-helper-process.ts` (spawn driver: `runOnce`, `startSession`),
  `apple-cases.ts` (21 shared invalid requests + one awkward valid one).
- Tests: `test/providers/apple-protocol.test.ts`, `fake-apple-llm.test.ts` (fast tier, CI),
  `apple-helper.local.test.ts` (local tier: `swift build -c release`, weak-link check with
  `otool -l`, `swift test`, `--status`, shared invalid cases, one text and one schema request).
- `packages/agent/package.json`: `test` script, `zod` 4.6.5 (exact).

**Numbers**: agent package on CI tier (`CI=1`) 115 passed; locally 125 passed, 1 skipped (the
`unavailable` case: the model is ready here, the fake covers it). `swift test` 30 tests passed.
On the M5: `--status` → `{"status":"ready","contextSize":8192}`; a text request and a schema request
(enum, bounded integer, bounded array) answer and pass zod.

**Review** (swift-reviewer and typescript-reviewer focus): every CRITICAL and HIGH fixed with tests
(integer bound overflow, unchecked array/number bounds, uncapped `maxTokens`, lone surrogates,
U+2028/U+2029 line splitting, malformed fake script, unsafe `maxTokens`). Not done on purpose:
`oneOf`/`$ref` support (dropped per spec), a line-size cap and a per-request timeout in the helper
(the provider owns timeouts and kills the process), a check that a `hang` fake exits on stdin close
(a stuck real helper does not either).

**Left for phase 11**
- `agent/src/providers/apple.ts` (`LanguageModelV4` over this protocol, after the `ai` pin): spawn
  the bundled helper, `JsonLineSplitter`, request ids, timeout → kill and restart, `--status` → mode.
- Probe, `apple` preset (keyless), mode selection forcing plan mode; step 12's provider tests
  against the fake (text, schema, every status, crash, timeout).
- Step 12 says the Swift smoke test is tagged `slow`; it is `*.local.test.ts` (D-16, D-22).
  The phase 11 Verify line `pnpm -C packages/agent test:slow -- apple` should become the local run.
- Bundling `vox-apple-llm` into `<resources>/bin/` is phase 13.

## Early steps (D-19) — g1-agent-utils

Package G1 (pure agent utilities). Branch `early/g1-agent-utils`, merged to main (merge commit f6a0ce7, pushed; worktree removed).
Imports nothing from `@vox/engine`; errors use a local `UtilError` shim (D-26).

**Steps done**
- Step 5 in full: `loop/envelope.ts` (`escapeData`, `wrapData`; S21, also the S34 `vision` source).
- Step 1, the pure half: `config/mask.ts` (`maskKey`, `isMaskedKey`, `keyInputIsUnchanged`,
  `parseKeyRef`/`formatKeyRef`, `assertSafeBaseUrl`) and `config/keychain.ts` (`Keychain` interface,
  `createSecurityKeychain`, `resolveApiKey`, `runProcess`); S17 key refs and `baseUrl`, S30 spawn spy.
- Step 7, the math half: `providers/prices.ts` (`costOfUsage`, `costFromReported`,
  `stepUpperBoundUsd`, `exceedsBudget`, `priceStatus`, `assertRoleModelPriced`, `lookupPrice`,
  `parseOpenRouterPricing`, `costOfImages`, `Price`/`PriceEntry` zod). No price data is bundled.
- Step 16, the pure half: `loop/repair.ts` (`repairToolJson`, `parseToolInput`, `detectTextToolCall`,
  `TEXT_TOOL_CALL_CORRECTION`).

**Files**: `packages/agent/src/{errors.pending.ts,loop/envelope.ts,loop/repair.ts,config/mask.ts,
config/keychain.ts,providers/prices.ts}`; tests `test/{loop/envelope,loop/repair,config/mask,
config/keychain,config/keychain.spawn,config/keychain.local,providers/prices}.test.ts`,
`test/helpers/canary.ts`. N1's files are untouched.

**Numbers**: agent package 335 passed + 1 skipped locally (`CI=1`: the real-Keychain file is skipped);
root `pnpm test` 407 passed, 1 skipped; typecheck and eslint clean; `uv run --project py pytest` 58
passed (after `make.sh`). The real-Keychain test (service `Vox Studio Test`, unique account) passed
on the M5 and left no item behind.

**Review** (typescript-reviewer and security-reviewer focus): 2 HIGH and 10 MEDIUM, all fixed with
tests: quadratic scans in text tool-call detection and `MARKERS` (now one linear pass, 200k cap),
repair start in prose (`See [1] {…}`), cut `\u` escape after an escaped backslash, `baseUrl` bypasses
(camelCase names, `;`, path segments, fragments), key leak risk in the write-failure cause, masking of
short keys, upper bound under-counting cache-write/reasoning rates, NaN budget check, reported cost 0,
`isMaskedKey` vs `maskKey`, `keychain:` ref not bound to its provider, zero-width/control/fullwidth
variants of `<data` in the envelope. Not done on purpose: the `env:NAME` allow-list and plain-`http:`
question (D-26, left for phase 11).

**Left for phase 11**
- Swap `errors.pending.ts` for `VoxError`; append `CONFIG_INVALID`, `KEYCHAIN_FAILED`, `PRICE_MISSING`.
- Step 1 remainder: provider entries/roles/limits through the engine's `readConfig`/`writeConfig`
  (an agent save keeps `contact` and `projectsDir`); register resolved keys with
  `engine.redactor.addSecrets`; call `keyInputIsUnchanged` in the settings save path; use
  `resolveApiKey(ref, deps, entry.id)`. Prefer `hint`s from `UtilError` unchanged.
- Step 7 remainder: the OpenRouter models fetch feeding `parseOpenRouterPricing`, the editable price
  table file (`agent/prices.json`: values are not in the spec, so none were invented), per-image table,
  and the loop's pause on `exceedsBudget`. A `ProviderKind.preset` field must come from the preset the
  entry was created from (config entries have no preset today).
- Step 16 remainder: the loop uses `parseToolInput` before dispatch, calls `detectTextToolCall` once
  per step with the run's tool names and sends `TEXT_TOOL_CALL_CORRECTION`, and counts identical calls.
- Envelope use: wrap transcript/caption/vision text with `wrapData`; the system prompt rule stays in 11.
- Decide the `env:NAME` allow-list question and `http:` to non-loopback hosts (D-26).

## Early steps (D-19) — g2-providers

Branch `early/g2-providers` (worktree `.worktrees/early-g2-providers`), from main b2a7b41, main
merged in at 9f37d55. No `@vox/engine` import; errors use the G1 `UtilError` shim. Decisions: D-38.
N1 and G1 files are only imported.

**Done** (all in `packages/agent`, tests first, `MockLanguageModelV4` or the fake helper, no network):
- Pins (R5 filled): `ai` 7.0.137, `@openrouter/ai-sdk-provider` 3.1.0, `@ai-sdk/anthropic` 4.0.78,
  `@ai-sdk/openai` 4.0.91, `@ai-sdk/google` 4.0.93, `ollama-ai-provider-v2` 4.0.1,
  `@ai-sdk/openai-compatible` 3.0.67, `@ai-sdk/provider` 4.0.26. All Apache-2.0; transitive MIT and
  `json-schema` (AFL-2.1 OR BSD-3-Clause).
- `src/providers/presets.ts`: preset table (claude, openrouter, opencode-zen, 9router, lmstudio,
  ollama, apple, openai, gemini), `ProviderEntry` schema (loose, `preset?`, `options.numCtx`,
  `options.contextTokens`), `requiresKey`, `providerEntryFromPreset` (key ref `keychain:<id>`).
- `src/providers/factory.ts`: `createLanguageModel(entry, modelId, {apiKey, fetch?, apple?})` builds
  a `LanguageModelV4` per type; Zen routes by model family; Ollama `num_ctx` middleware; keyed
  provider without a key → `CONFIG_INVALID`; base URL through `assertSafeBaseUrl`.
  `resolveEntryKey` resolves through G1 `resolveApiKey(ref, deps, entry.id)`.
- `src/providers/capture.ts`: captures the first request a provider package would send (URL,
  headers, body) and rejects it; used for wire tests and the tool-list measure.
- `src/providers/apple.ts`: `LanguageModelV4` over `vox-apple-llm` (argument array, minimal env,
  `JsonLineSplitter`, serial requests with ids, timeout → SIGKILL + restart, crash → `APPLE_FAILED`
  with stderr tail, abort, `--status` → `APPLE_UNAVAILABLE` with hint, `contextOverflow` →
  `CONTEXT_OVERFLOW`, guided generation from `responseFormat.schema`, stream). Tools, files and a
  non-user last message are refused (`UnsupportedFunctionalityError`/`InvalidPromptError`).
- `src/providers/probe.ts`: tools, loop, vision (generated solid-colour PNG), plan/json checks;
  results carry codes or HTTP status only, never provider text.
- `src/providers/context.ts`: OpenRouter models list (context, price via G1
  `parseOpenRouterPricing`, modalities, tools), Ollama `/api/show`, `detectContext` per D-38.
- `src/providers/tool-cost.ts`: `toolDefinitions`, `serializedToolList` (provider's own `tools`
  JSON), `estimateTokens`, `checkToolListCost` (25 %), `measureToolListCost`.
- `src/providers/roles.ts`: `ROLES`, `EDITOR_MIN_CONTEXT` 32,000, `selectMode`, `roleCheck`,
  `assertRoleAssignable` (`PRICE_MISSING` via G1, else `PROBE_FAILED` with the failed checks).
- Tests: `test/providers/{presets,factory,apple,probe,context,tool-cost,roles}.test.ts`,
  `test/providers/apple.local.test.ts` (real helper: status, context, text, stream, schema, plan
  probe and role verdict; skipped with the reason off macOS 26 SDK), fixture
  `test/fixtures/fake-apple-llm-restarts.mjs` (per-spawn scripts for restart tests).

**Numbers**: after merging main, root `pnpm test` 128 files, 1908 passed, 1 skipped (local tier
on, Apple helper ready on the M5); `pnpm typecheck` and `pnpm lint` clean;
`uv run --project py pytest` 109 passed (after `make.sh`).

**Review**: self-review (owner asked to cut token cost; no review agents). Fixed: parameter property
in `apple.ts`, a late exit of an old helper rejecting a new request (`failFor(child)`), function-typed
tool descriptions in `toolDefinitions`, context fetches now go through `assertSafeBaseUrl` (a base URL
with credentials is refused before any request; test added).

**Left for phase 11**
- Swap `UtilError` for `VoxError`; append `APPLE_UNAVAILABLE`, `APPLE_FAILED`, `CONTEXT_OVERFLOW`,
  `PROBE_FAILED` (with G1's `CONFIG_INVALID`, `KEYCHAIN_FAILED`, `PRICE_MISSING`).
- Tool generation from engine zod schemas, `allowedTools`/`describe_tool`/`call_tool`, feeding the
  real largest list to `measureToolListCost`; the loop, compaction, plan mode executor, `ClipPlan`
  as the plan probe task; config persistence of entries (with `preset`) and probe reports; redactor
  registration of resolved keys; `vox config providers add|roles set|probe` (calls
  `assertRoleAssignable`); the live probe (MANUAL STEP already in the phase plan).

## Merge (orchestrator, 2026-10-11 19:22)
Owner chose to enter provider keys through the Settings screen (D-44), so MANUAL STEPS 1–2 move to
phase 13 step 7b. After `git merge main` (10a, D-44): typecheck and lint clean; `pnpm test` 2254
passed, 1 skipped, and one timing test failed per full run while phase 10b ran in parallel (load
average ~14): `lock.test.ts` (break marker 10 s) once, `preview.test.ts` (150 ms coalesce) once.
Each passed 3/3 alone. Flaky under load, not a regression.

## Phase 13 step 7b — live probe with the keyless providers (2026-10-12)
Run by the phase 13 agent (owner delegation, D-49/D-58) with a temp `VOX_HOME`, through `vox config probe --json`
(the same probe runner the Settings "Test" button calls). No OpenRouter key exists, so MANUAL STEP 1 stays open
for OpenRouter (TODO "Manual steps"); MANUAL STEP 2 (optional presets) stays open.

| Model | Context | tools | loop | vision | plan | Tool-list share | Roles assignable |
|---|---|---|---|---|---|---|---|
| `ollama:qwen3.5:latest` | 32768 (`num_ctx`; advertised 262144) | pass | pass | pass | pass | 9.6 % | editor (plan), vision, fast |
| `ollama:nimble:latest` | 32768 | pass | pass | error (`AI_RetryError`; text-only model) | pass | 9.6 % | editor (plan), fast |
| `apple:apple-on-device` | 8192 | — | — | — | pass | — | fast |

Found and fixed on the way (phase 13 branch): the Ollama vision probe crashed inside `ollama-ai-provider-v2`
(`Cannot read properties of undefined (reading 'replace')`) on inline image bytes; the provider now gets them
as base64 (`inlineFilesAsBase64`, test in `factory.test.ts`).
