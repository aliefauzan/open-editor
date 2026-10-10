# Phase 11 — Agent core

| Field | Value |
|---|---|
| Track | agent |
| Prereq | 05 (GATE 2) (may run in parallel with 07–10b) |
| Spec § | agent "Providers and models", "Model roles", "Capability probe", "Configuration and keys", "Secret redactor", "Cost tracking", "Tools", "Untrusted content and threat model", "Agent loop", "Plan mode", "Error handling" |
| Model | Opus 5.5 · high |
| Gate | — |
| Next | 12 |

## Goal

A safe, model-agnostic agent runtime: any provider through the user's key, typed tools generated from
engine schemas, a loop with compaction, cost caps and run records, plan mode for weak models, and keys
that never leak. No workflows yet (phase 12).

## Required reading

- Agent spec sections above; R4 rows S17–S24, S30; R5 AI SDK rows.
- AI SDK 7 docs: `streamText`, `stopWhen: stepCountIs`, tool `inputSchema`, `APICallError`,
  `MockLanguageModelV4` from `ai/test`.

## Output

- `agent/src/config/`: provider entries, roles and limits in `~/.vox/config.json`, read and written only
  through the engine's `readConfig`/`writeConfig` (which own the file and its `0600` mode); key refs `keychain:<providerId>`
  (macOS `security` command, service `Vox Studio`; writes go through `security -i` with the command on
  stdin, so a key is never in any process's argv, S30) and `env:NAME`; masking (`sk-or-…a1b2`), "masked or
  absent = unchanged"; `baseUrl` with credentials rejected; default limits ($2.00, 60 steps); `numCtx`.
- `agent/src/providers/`: factory for OpenRouter, Anthropic, OpenAI, Gemini, Ollama, OpenAI-compatible
  and Apple on-device; presets `claude`, `openrouter`, `opencode-zen`, `9router`, `lmstudio`, `ollama`,
  `apple` (agent spec "Providers and models", D-10); roles `editor`, `vision`, `fast`, optional `image`,
  `embed`; probe (tools, loop, vision, context incl. OpenRouter `context_length` and Ollama `/api/show`,
  plus `plan`: one `ClipPlan` for a fixture sequence and its transcript validates); a model that fails a role's probe
  cannot be assigned to it; prices (OpenRouter endpoint or bundled editable table; provider-reported cost
  preferred; per-image table; a paid model with no price cannot fill a role until priced or marked free);
  OpenRouter image `ImageProvider` registration.
- `agent/src/providers/apple.ts`: custom `LanguageModelV4` over the helper's JSON-lines protocol (text and
  JSON-Schema output, usage, timeout, crash → `VoxError` with hint); plan mode only; cost 0.
- `native/apple-llm/` (Swift Package with `platforms: [.macOS(.v14)]`; every Foundation Models call
  behind `if #available(macOS 26, *)`, so on macOS 14–15 `--status` prints `unsupportedOS` instead of
  failing to start): `vox-apple-llm`, built with
  `swift build -c release --package-path native/apple-llm`. Reads JSON lines from stdin; uses
  `SystemLanguageModel.default` and `LanguageModelSession`; a request `schema` becomes a
  `DynamicGenerationSchema` (guided generation); `--status` prints availability and context size (the
  framework's `contextSize` when present, else 4,096). No file or network access. CI builds it only on a
  runner with the macOS 26 SDK; elsewhere the fake helper covers the protocol.
- `agent/test/fixtures/fake-apple-llm.mjs` (same protocol, scripted answers and statuses) and
  `agent/test/fixtures/transcripts/injection.json` (the S20 injection transcript, used by 12).
- Redaction through the engine's redactor (built in 04): every key value is registered with
  `engine.redactor.addSecrets` as soon as it is read; run records, logs, events and every `APICallError`
  field (`url`, `requestBodyValues`, `responseHeaders`, `responseBody`, `data`, `message`) pass through
  `engine.redactor.redact`.
- `agent/src/tools/`: read tools, one write tool per engine op (actor `agent`, `runId`), job tools,
  `undo_my_last_edit` (own run only), `view_frames`/`view_media` with vision fallback; no shell/file/HTTP.
- `agent/src/loop/`: `streamText` loop; system prompt = base + style `guide.md` + workflow prompt +
  compact summary; `<data source>` envelope with escaping; `ingest` source rule with `approval` pause;
  compaction at 70 % (stubs older than 8 steps, then `fast` summary); budget upper bound with per-role
  `maxOutputTokens` (8,000/2,000/2,000); run record `runs/<runId>.jsonl`; events `agent.started|step|tool|
  paused|done`; provider error mapping + retries; zod error feedback (max 2); `STALE` re-read once; stop.
- `agent/src/loop/plan.ts`: plan mode (`ClipPlan` and op-list plans, zod-validated, executor to `batch`,
  slot filling, small repairs, 2 retries); mode selection.
- `vox config providers add <preset>|roles set|probe` in `packages/cli`.

## Steps (tests first; all with `MockLanguageModelV4`, no network)

1. [ ] Config: masking, masked-means-unchanged, writes only through the engine config module (an agent
       save keeps `contact` and `projectsDir`), Keychain ref round trip (Keychain calls behind an
       interface; real Keychain test tagged `slow`, using service `Vox Studio Test` and deleting its items), `baseUrl` credential rejection (S17, S18). S30: with
       a spawn spy, the canary key appears in no spawned process's argv (Keychain write included); it is
       written to `security -i` stdin.
2. [ ] Redaction: the canary key never appears in run records, logs, events, `VoxError`, or a forced
       `APICallError` (all fields) (S19).
3. [ ] Tool generation covers every engine op (snapshot of tool names = op names); no shell/file/HTTP tool (S22).
       `get_transcript` on a long fixture transcript returns ≤ 4k tokens per call and its next-page cursor
       walks the whole transcript without gaps or repeats.
4. [ ] `undo_my_last_edit` cannot undo a user edit; fails when keys changed since (S24).
5. [ ] Envelope escaping: payload containing `</data>` stays inside (S21).
6. [ ] `ingest` source rule: unlisted source pauses with `approval` (S20).
7. [ ] Cost: price calc incl. cache/reasoning tokens; upper-bound pause before a step that could exceed (S23);
       an unpriced paid model cannot be assigned until priced or marked free; local providers cost 0.
8. [ ] Compaction stubs and summary trigger.
9. [ ] Plan mode: valid plan → `batch`; invalid → zod error back, 2 retries; repairs clamp/drop.
10. [ ] Probe against mock models (pass/fail per capability, incl. `plan`); assigning a role to a model that
        failed its probe is refused (`vox config roles set` exits 1 with the failed capability); live probe
        tagged `slow`.
11. [ ] Presets: each preset builds the right provider object and base URL; keyless presets (`lmstudio`,
        `ollama`, `apple`) store no `apiKey`.
12. [ ] Apple provider against the fake helper: text, schema output, every `--status` value, crash,
        timeout; mode selection forces plan. Swift helper: `swift build` and a smoke test (`--status`, one
        short request) tagged `slow` and skipped with the reason unless macOS 26+ with Apple Intelligence on.
13. [ ] Error mapping: 401/429/5xx/context overflow → `VoxError` with hints; backoff; pause after 3;
        context overflow triggers one forced compaction and one retry, then fails (test).

## Verify

```bash
pnpm -C packages/agent test
swift build -c release --package-path native/apple-llm   # needs the macOS 26 SDK (TODO "Local tools")
pnpm -C packages/agent test:slow -- apple               # skipped with the reason if Apple Intelligence is off
pnpm -C packages/cli exec vox config probe --json     # live; needs owner's keys (MANUAL STEP)
```

## Done when

- [ ] S17–S24 and S30 tests pass; security review clean of CRITICAL/HIGH.
- [ ] Apple provider passes against the fake helper; on the M5 with Apple Intelligence on, the real helper
      reports `ready` and `vox config probe` shows its capabilities (else the skip reason is logged).
- [ ] MANUAL STEP (owner): add an OpenRouter key and an Ollama model; `vox config probe` reports tools,
      loop, vision and context for both (agent done-when #1). Optional (does not block merge): add any of
      `claude`, `opencode-zen`, `9router` and probe them too.
- [ ] R5 AI SDK and provider pins filled.

## Risks and fallback

| Risk | Fallback |
|---|---|
| A provider package lags AI SDK 7 | Use `@ai-sdk/openai-compatible` with that provider's base URL; record in DECISIONS |
| `security` CLI prompts on every read | Use `-T` access for the app and CLI paths; document the one-time "Always Allow" |
| Apple model too small for any role but `fast` | Expected: the probe decides; it stays a free `fast` option |
| Foundation Models API differs from the spec (new SDK) | Keep the JSON-lines protocol fixed; adapt only `main.swift`; record in DECISIONS |

## Handoff notes

- Phase 12 adds workflow prompts and checkpoints on this loop; phase 13 forwards `agent.*` events to the UI.
