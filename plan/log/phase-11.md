# Phase 11 — Agent core

Status: not started; early steps done under D-19

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

Package G1 (pure agent utilities). Branch `early/g1-agent-utils`, merged to main (see the merge
commit below). Imports nothing from `@vox/engine`; errors use a local `UtilError` shim (D-26).

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
