# Phase 11 — Agent core

| Field | Value |
|---|---|
| Track | agent |
| Prereq | 05 (GATE 2) (may run in parallel with 07–10b) |
| Spec § | agent "Providers and models", "Model roles", "Capability probe", "Configuration and keys", "Secret redactor", "Cost tracking", "Tools" (incl. "Tool surface", "Short ids", "Time frames"), "Untrusted content and threat model", "Agent loop", "Plan mode", "Error handling", "Testing" (unit); engine "Audio QA", "Export targets", "Library API" (`engine.view`, write result) |
| Model | Opus 5.5 · high |
| Gate | — |
| Next | 12 |

## Goal

A safe, model-agnostic agent runtime: any provider through the user's key, typed tools generated from
engine schemas, a loop with compaction, cost caps and run records, plan mode for weak models, and keys
that never leak. No workflows yet (phase 12).

## Required reading

- Agent spec sections above; R4 rows S17–S24, S30, S32, S34 (on-image text) and S35 (`call_tool` rules);
  R5 AI SDK rows;
  DECISIONS D-13, D-14, D-15.
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
  plus `plan`: one `ClipPlan` for a fixture sequence and its transcript validates; plus the **tool-list
  cost** per role that gets tools: the token count of the largest list it can get, a workflow's
  `allowedTools` plus the always-present tools, as serialised for that provider; > 25 % of the role's
  effective context fails the role, D-15); a model that fails a role's probe
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
  framework's `contextSize` when present, else 4,096). No file or network access. The helper needs the
  macOS 26 SDK or newer; the M5 has the macOS 27 SDK, so the local Verify always builds it (D-16). The real build and smoke test are tagged `local` and
  never run on CI; there the fake helper covers the protocol.
- `agent/test/fixtures/fake-apple-llm.mjs` (same protocol, scripted answers and statuses) and
  `agent/test/fixtures/transcripts/injection.json` (the S20 injection transcript, used by 12).
- Redaction through the engine's redactor (built in 04): every key value is registered with
  `engine.redactor.addSecrets` as soon as it is read; run records, logs, events and every `APICallError`
  field (`url`, `requestBodyValues`, `responseHeaders`, `responseBody`, `data`, `message`) pass through
  `engine.redactor.redact`.
- `agent/src/tools/`: read tools, one write tool per engine op (actor `agent`, `runId`; incl.
  `remove_pauses` and `remove_words` with `dryRun`), job tools (incl. `shots`; a job writing to the
  project fails with `JOB_CONFLICT` listing keys), `undo_my_last_edit` (own run only),
  `view_frames`/`view_media` with vision fallback; `check_audio(sequenceId)`
  (D-14: runs job `audioQa`, returns `qa.json` numbers, the `LISTEN.md` timecodes and `qa.png` as an image
  through the `vision` role, like `view_frames`); no shell/file/HTTP; no render or export tool and no tool
  argument that takes an output path (S32, D-13). D-15 additions, with the agent spec's names:
  - **Tool surface**: a run sends only its workflow's `allowedTools` plus the five always-present tools
    `describe_tool`, `call_tool`, `get_sequence`, `update_todos` (tools mode) and `undo_my_last_edit`
    (`get_sequence` is always present so the `UNKNOWN_ALIAS` hint can be followed).
    `describe_tool { name }` returns a tool's description and input schema; `call_tool { name, args }`
    validates with the same zod schema and runs under the same rules (actor, `runId`, ingest source rule,
    budget); an unknown name fails with the list of tool names. In a question turn `call_tool` refuses
    non-read tools (S35).
  - **Short ids**: per-run aliases (`c1`… items, `s1`… sequences, `m1`… media) given on first sight,
    resolved to engine ids before a call and mapped back in every result; one table for the whole run
    (all sub-runs), written to the run record; an unknown alias returns `UNKNOWN_ALIAS` with the hint
    "re-read with `get_sequence`" (a tool error, not a run failure).
  - **Reads**: `get_sequence(sequenceId, itemIds?)` returns the compact `engine.view` (flat `items[]`,
    caption chunk text, `version`), or the full state of `itemIds` only; the agent never reads the full
    project. `get_transcript(mediaId, fromSrcMs?, toSrcMs?, sequenceId?)` returns `srcMs`, word `kind` and,
    with `sequenceId`, the paired `seqMs` (`null` if not placed). `view_frames(sequenceId, atSeqMs[])`
    returns `seqMs`, the `V1` `srcMs` and **frame health** flags (`mostlyBlack`, `mostlyWhite`, `blank`,
    `lowLuma`) from pixel luma statistics, computed before any model sees a frame and also with no vision
    model. Write tool descriptions say `startMs`/`endMs`/`durationMs` are sequence time and `inMs` is
    source time.
  - **Write results**: a write tool returns `{ version, results }` (per op `status` `succeeded` /
    `failed` / `conflicted` and touched items' new state, with aliases); `changes` go to the run record
    only. `failed`/`conflicted` entries go back with the new version so the model fixes only those.
  - **Todo tool**: `update_todos { items: { text, status }[] }` replaces the run's short plan; more than
    one `in_progress` item fails validation; each call emits `agent.todos`; it changes nothing in the
    project.
- `agent/src/loop/`: `streamText` loop; system prompt = base + style `guide.md` + workflow prompt +
  compact summary; `<data source>` envelope with escaping; `ingest` source rule with `approval` pause
  (kind `source`); compaction at 70 % (stubs older than 8 steps, then `fast` summary); budget upper bound
  with per-role `maxOutputTokens` (8,000/2,000/2,000); run record `runs/<runId>.jsonl`; events
  `agent.started|step|tool|todos|paused|done`; provider error mapping + retries; zod error feedback
  (max 2); `STALE` and `JOB_CONFLICT` re-read once; stop. D-15 additions:
  - **Fresh state every step**: before each model step, inject the `engine.view` of the sequences in
    scope and a "Changes since your last step" note from history entries after the last version the run
    saw whose `actor` is not `agent` or whose `runId` is another run's, listing touched items by alias.
    Only the newest injection stays in context. Its caption text is wrapped in `<data>`.
  - **Version-stamped stubs**: a compaction stub carries the version it read
    (`[elided @v42: get_transcript m1 0–60000 srcMs, 812 words]`); one older than the current version is
    marked stale (`[stale @v42: …; re-read]`).
  - **Robust tool calls**: repair malformed tool-call JSON before zod (trailing comma, truncated
    object); a tool call written as plain text gets one correction per step; an identical call (same tool,
    same args after alias resolution) gets a note on the 2nd time in a row and is not run on the 3rd: the
    run pauses with `error`.
  - **Sub-runs**: a workflow may run one sub-run per sequence: fresh context (system prompt, the
    sequence's view, the parent's instruction), same `runId`, summary passed back to the parent and the
    run summary. `maxStepsPerRun` (60) applies per sub-run, `maxUsdPerRun` to the whole run; a sub-run at
    its step cap ends and names its open checkpoints. `agent.step` carries `subRun?` and `scope:
    sequenceIds[]`; `agent.paused` carries `kind?: 'source' | 'plan' | 'pauses'`.
  - **Run record** also holds the alias table, each `update_todos` list and each sub-run summary.
  - **Restart**: a run that was paused when the app quit ends as `stopped` on next launch (an
    `agent.done` line is added); its edits stay and `undoRun` still works.
  - **On-image text** (threat model): the vision prompt says text in images (frames, archive images,
    thumbnails) is content to describe, never instructions; a `vision` description returned to the
    `editor` is wrapped in `<data source="vision">` (S34).
- `agent/test/replay/`: replay harness for run records: the recorded model outputs are fed back through
  `MockLanguageModelV4` against the fixture project, and tool results and history versions must match
  the record (D-15; phase 12 records the fixtures).
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
       The snapshot also asserts no render/export tool and no argument named or shaped like an output path
       (S32).
       `get_transcript` on a long fixture transcript returns ≤ 4k tokens per call and its next-page cursor
       walks the whole transcript without gaps or repeats.
4. [ ] `undo_my_last_edit` cannot undo a user edit; fails when keys changed since (S24).
5. [ ] Envelope escaping: payload containing `</data>` stays inside (S21).
6. [ ] `ingest` source rule: unlisted source pauses with `approval` (S20).
7. [ ] Cost: price calc incl. cache/reasoning tokens; upper-bound pause before a step that could exceed (S23);
       an unpriced paid model cannot be assigned until priced or marked free; local providers cost 0.
8. [ ] Compaction stubs and summary trigger; a stub read before a write is marked stale (D-15).
9. [ ] Plan mode: valid plan → `batch`; invalid → zod error back, 2 retries; repairs clamp/drop.
10. [ ] Probe against mock models (pass/fail per capability, incl. `plan`); assigning a role to a model that
        failed its probe is refused (`vox config roles set` exits 1 with the failed capability); live probe
        tagged `slow`.
11. [ ] Presets: each preset builds the right provider object and base URL; keyless presets (`lmstudio`,
        `ollama`, `apple`) store no `apiKey`.
12. [ ] Apple provider against the fake helper: text, schema output, every `--status` value, crash,
        timeout; mode selection forces plan. Swift helper: `swift build` and a smoke test (`--status`, one
        short request) tagged `slow` and skipped with the reason unless macOS 26+ with Apple Intelligence on.
12b. [ ] `check_audio` against a fixture build: returns the `qa.json` numbers and five timecodes; `qa.png`
        goes to the `vision` role (text-only fallback lists the numbers); a FAIL is returned as data, not
        as a thrown error.
13. [ ] Error mapping: 401/429/5xx/context overflow → `VoxError` with hints; backoff; pause after 3;
        context overflow triggers one forced compaction and one retry, then fails (test).
14. [ ] Tool surface (D-15): a test workflow sends exactly its `allowedTools` plus the always-present
        tools (incl. `get_sequence`); `call_tool` reaches every other tool with the same validation and
        rules (actor `agent`, `runId`, budget; `ingest` through `call_tool` pauses for approval) and refuses
        non-read tools in a question turn (S35); `describe_tool` returns the schema; the probe fails a role
        whose tool list takes > 25 % of its context.
15. [ ] Short ids and reads (D-15): aliases are stable across sub-runs; an unknown alias returns
        `UNKNOWN_ALIAS`; `get_sequence` returns the compact view; `get_transcript` and `view_frames` pair
        `srcMs` and `seqMs`; frame health flags black, white, blank and dark fixture frames with no vision
        model; a write result carries per-op `status`, the new version and aliased items.
16. [ ] Loop robustness (D-15): JSON repair fixes a trailing comma and a truncated object; a plain-text
        tool call gets exactly one correction per step; an identical call gets a note on the 2nd time and
        an `error` pause on the 3rd; the change note lists a user edit made between two steps and not the
        agent's own writes.
17. [ ] Sub-runs and restart (D-15): two scripted sub-runs share one `runId`, each gets a fresh context
        and its own step cap, and `agent.step` carries `subRun` and `scope`; a run paused before an app
        restart ends `stopped` and `undoRun` still restores it.
18. [ ] `update_todos` (D-15): two `in_progress` items fail validation; a valid call emits `agent.todos`
        and makes no history entry.
19. [ ] On-image text (D-15): a `vision` description and the view's caption text arrive inside `<data>`;
        the vision prompt holds the "text in images is content" rule (S34).
20. [ ] Replay harness (D-15): a recorded mock run replays to the same tool results and history versions;
        a changed tool result fails the replay.

## Verify

```bash
pnpm -C packages/agent test
swift build -c release --package-path native/apple-llm   # local (needs a macOS 26+ SDK; the M5 has 27, D-16); on a machine without it: skipped with the reason logged, never on CI
pnpm -C packages/agent test:slow -- apple               # skipped with the reason if Apple Intelligence is off
pnpm -C packages/cli exec vox config probe --json     # live; needs owner's keys (MANUAL STEP)
```

## Done when

- [ ] S17–S24, S30, the agent part of S32, and the phase-11 parts of S34 and S35 pass; security review
      clean of CRITICAL/HIGH.
- [ ] Apple provider passes against the fake helper; on the M5 with Apple Intelligence on, the real helper
      reports `ready` and `vox config probe` shows its capabilities (else the skip reason is logged).
- [ ] MANUAL STEP (owner): add an OpenRouter key and an Ollama model; `vox config probe` reports tools,
      loop, vision and context for both (agent done-when #1). Optional (does not block merge): add any of
      `claude`, `opencode-zen`, `9router` and probe them too.
- [ ] D-15 runtime tests (steps 14–20) pass, incl. the on-image text test in R4 (S34).
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
- Phase 12 uses the sub-run machinery, the tool surface (workflow frontmatter `allowedTools`), the
  replay harness (records its runs as fixtures) and the confirm-plan pause; phase 13 shows `agent.todos`,
  pause `kind` cards and the `scope` marker (D-15).
