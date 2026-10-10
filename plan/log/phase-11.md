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
