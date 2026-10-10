# CapCut 9.4.1 (macOS) agent layer, compared with the Vox agent spec

Date: 2026-10-10. Method: static analysis only. CapCut and its binaries were never run.
Printable strings were extracted from the app's dylibs with a Python extractor and grepped
(Xcode CLI tools were unavailable on the host). Extracted text was treated as untrusted data.
Prompt text is paraphrased, not copied.

Confidence: **[C]** confirmed by an exact string; **[I]** inferred from symbol names, string
placement, or a string being absent (absence does not prove a feature is missing).

Evidence files (`$S` = session scratchpad, not committed): `libdeepagents_capi.txt`,
`libDeepAgentsService.txt`, `libVECreator.txt`. Counts are `grep -cF` hits.

## 1. Runtime and architecture

| Finding | Evidence | Conf |
|---|---|---|
| Agent is a Go 1.25 library | capi `Go build ID` (2), `__gopclntab` | C |
| ByteDance deepagents SDK on CloudWeGo Eino ADK | capi `carrier-agent-sdk/deepagents` (5864), `cloudwego/eino/adk` (240) | C |
| Model clients for Ark (Doubao), Gemini, OpenAI, llmgateway, Anthropic | capi `api.anthropic.com`, `ark.cn-beijing.volces.com`, `main.anthropicChatModel` | C |
| `da_*` C API with JSON payloads | capi `da_session_rewrite_history`, `da_tool_call_reply_impl`, `da_execution_gate_reply_impl` | C |
| Host supplies tools, model HTTP, gates, events | capi `da_call_host_list_tools_scoped`, `HostBridgeTransport`, `da_call_host_model_generate` | C |
| Separate Mojo service process; no MCP | svc `DeepAgentToolHost` (217), `deepagents_service.mojom.*` | C (no MCP: I) |
| Tools are C++ inside libVECreator | vec `local_sdk_tools` (130); ~60 agent `.cpp` paths | C |
| Local and cloud agent channels | vec `NuroAgentChannel`, `LocalAgentChannel`, `AgentChannelRouter` | C |
| One SQLite DB per draft, AES-GCM field encryption, schema versioning | capi `schema_too_new`, `target_db_size_mb`, gorm + go-sqlite3 | C |
| Tracing via Fornax and CozeLoop | capi `fornax_sdk`, `cozeloop-go` | C |
| No local LLM; ASR can be local | `enable_local_asr` present; no on-device LLM strings near agent code | I |

## 2. Agent loop

- **Middlewares** [C]: planning (`write_todos`), sub-agents (`task` with `fork_context`),
  summarization, memory, filesystem, web, skill, PatchToolCalls, RepairJSON.
- **Robustness** [C]: `ToolJSONRepairInterceptor` (14) repairs broken tool-call JSON;
  `ErrRepeatedToolCallDetected` (12) with `ToolLoopGuardConfig` blocks an identical repeated
  batch then ends the round; `WithMaxSteps` caps steps; a retry when the model describes a
  tool call as plain text.
- **Control and gates** [C]: `HostControlledDriver`, `HybridLoopDriver`, `Interrupt`,
  `StepResume`, `GateResume`; hooks `BeforeModelRequest`, `AfterModelOutputBeforeToolBatch`,
  `BeforeToolCall`, `AfterToolCall`, `BeforeFinalModelOutput`; human-in-the-loop tools
  `InvokableApprovableTool`, `InvokableReviewEditTool`; per-turn tool hiding
  (`toolVisibilityChatModel`).
- **Context management** [C]: `context_max_input_tokens`, `keep_budget_fraction`,
  `recent_tool_turns_to_keep`; a projector shrinks old tool results; a summarizer with fixed
  sections (user intent, completed actions, current state, key decisions, active artifacts).
- **Persistence** [C]: transcript rounds, events, checkpoints, a sub-agent spawn tree
  (`GetConversationExecutionGraph`).
- **Host-side steps** [C]: pre-turn classifiers (`run_model_gate`, `run_model_classify`); an
  edit-intent classifier (`run_draft_modify_intent`) that links to `timeline_lock`; server plan
  generation (`plan_generation`) behind a gate and a commerce pre-charge; a fresh timeline every
  turn plus a `## Project Changes` block; `HTTPReasoningBeautifier` rewrites visible "thinking".
- **Turn order** [I]: classifiers → lock timeline if editing → build context (remote prompt,
  skills, timeline markdown, changes, selection/playhead) → ReAct loop with gates → optional
  post-tool confirm (`agent_result_confirm`) → save to SQLite.

## 3. Tool catalog

- **Delivery** [C]: a server config (`LocalAgentPcToolsConfig`) splits tools into `high_freq`
  and `low_freq`. Low-frequency tools are reachable only through `read_tools_schema` then
  `run_tool_after_read`. `enforceAsciiProgressiveSchema` rejects non-English schemas. Schemas
  are sha256-hashed. Semantic tool retrieval exists (`retrieve_tools`).
- **Composite tools** [C]: `inspect_project` takes an action (read_timeline,
  scan_video_content, inspect_frame, transcribe_audio, review_preview, locate_time_period,
  get_segment_info, extract_visual_events). `apply_*` tools take add / replace / update /
  remove / search.
- **Groups** (~150 tools):

| Group | Examples |
|---|---|
| Understand | `inspect_project`, `capture_preview`, `read_timeline`, `material_asr`, `text_clip_search`, `visual_events_extract` |
| Text | `add_text_caption`, `edit_captions`, `clean_transcript`, `subtitle_recognize`, `apply_text_style_preset` |
| Audio | `apply_effect_sound_batch`, `update_audio_fades`, `voice_separation`, `smart_loudness`, `search_and_text_to_speech` |
| Effects | `apply_transitions`, `apply_filters`, `apply_effects`, `apply_animations`, `smart_colors` |
| Generative | `generate_media`, `edit_media_content` |
| Edit | `remove_segments`, `ripple_delete`, `move_segments`, `split`, `update_segment_curve_speed`, `edit_keyframes`, `smart_highlight`, `operation_undo`, `operation_redo`, `player_seek` |
| Workflow | `rough_cut_plan_generation`, `composite_deeplink`, `workflow_edit` |

- **Execution** [C]: calls become clipflow node graphs; `DraftCliTool` translates them into an
  internal draft CLI (e.g. `draft edit --add "type=video;resource=..."`).
- **IDs** [C]: the model sees short segment IDs mapped back by the host; an unknown one returns
  `unresolved short segment id`.
- **Units** [C]: mixed — schemas in seconds, `inspect_frame` in microseconds, ASR in ms; prompts
  must warn the model to use `timeline_start_ms` rather than raw ASR times.
- **Rules in schema descriptions** [C], paraphrased: read the timeline before using IDs; ask when
  "this"/"same" is ambiguous; pass only the left segment for a transition; duration limits on
  generative edits; review the rendered preview after edits.

## 4. Prompts (paraphrased)

- Main system prompt is remote; the binary holds only a placeholder
  (`PLACEHOLDER_SYSTEM_PROMPT_MAIN`). [C]
- SDK planning prompt [C]: never show internal tool names or IDs; one todo in progress at a time;
  do not stop after planning to wait for approval; parallel sub-agents only for small atomic jobs.
- Skill prompt [C]: list only skill names and summaries; load a matching skill first.
- Timeline context [C]: markdown with `# Draft Info`, `## TIMELINE` (fps, canvas,
  track_index_base=0, unit seconds), `### Material`, `### Track`, `## Project Changes`; plus
  playhead (`current_seek_us`), user selection, referenced materials.
- Output tags [C]: `<plan>`, `<chat>`, `<summary>`, `<done>`.

## 5. Models and providers

- Model config is remote and encrypted (`RemoteModelConfigProvider`). [C]
- Clients for Doubao/Ark, Gemini, OpenAI, Anthropic are compiled in; the server picks. [C clients; I selection]
- Generative models include `seedance_1.0` and `high_aes_general_v40s`. [C]
- Vision sampling configs `global_vlm` (fps, width, max_frames, has_audio) and `events_vlm`
  (chunk_duration). [C]
- No on-device LLM found. [I]

## 6. Undo, verification, conflicts

- `operation_undo` / `operation_redo` act on the editor's shared undo stack; nothing scopes them
  to agent edits, so they can likely undo user edits. [C/I]
- Draft snapshots before and after a run (`base_draft`, `base_end_draft`). [C]
- Post-tool confirmation can pause for the user (`agent_result_confirm`). [C]
- Telemetry on the user deleting agent output (`trackCopilotOutputDelete`). [C]
- Timeline locked while an editing turn runs. [C/I]
- Verification: `capture_preview` grabs frames, runs model-free health checks (`mostly_black`,
  mostly_white, dark_ratio, mean_luma, `possible_blank_frame`), then sends frames to a VLM. [C]
- `AgentEval` replays cases by case_id with before/after snapshots. [C]
- Filler-word removal shows a review card (pauses, `speech_disfluency`, repetitions) before
  applying. [C]
- No prompt-injection defence strings found ("untrusted", "prompt injection": 0 hits). [I]

## 7. Skills

- `LocalAgentSkillsManager` copies built-in skills to a working folder, fetches `query_skills`
  from the server, diffs, downloads, validates and applies zips, with a crash-recovery backup. [C]
- Local `SKILL.md` files hold frontmatter only (name, description, version, keywords, author);
  bodies come from the server. [C]
- `FileSystemSkillLoader` parses `allowed-tools`; fork skills run in a child agent via `task`
  with `fork_context`. [C]
- Built-in skills: highlight (ASR + VLM, keeps setup and emotional tail), material
  understanding, edit script (plan only by default, several candidates, nothing placed on the
  timeline), speaker cleanup (fillers, pauses, repeats; splits long videos), BGM alignment (length,
  beat SFX, fade), long-to-short condensation with duration control. [C]

## Comparison with `2026-10-10-vox-agent-design.md`

### (a) CapCut has it, our spec lacks it (most valuable first)

| # | Spec section | Change |
|---|---|---|
| 1 | Agent loop; Workflow 2 Free-form | Inject a short current sequence summary every step, plus "Changes since your last step" from history entries with `actor:'user'` after the run's last seen version. |
| 2 | Tools | Short per-run aliases for item and media IDs, resolved by the engine; unknown alias returns an error with a re-read hint. |
| 3 | Tools (write tools) | Per-workflow tool subsets (clipper ≈ 12 tools) and a `describe_tool` / `call_tool` pair for the rest; optionally merge ops into action-enum tools; measure tool-list token cost in the capability probe. |
| 4 | Error handling | JSON repair before zod; detect a tool call written as plain text and inject one correction; stop identical repeated calls (note on 2nd, pause with `error` on 3rd). |
| 5 | Tools (`get_transcript`, `view_frames`); Plan mode | Return paired `srcMs` and `seqMs`; name the time frame in every time field. |
| 6 | Self-review | Model-free frame-health checks (black, white, blank, low luma), run even with no vision model. |
| 7 | Plan mode; CLI | `--confirm-plan` and an app toggle that shows the ClipPlan before running it. |
| 8 | Workflow 1 Clipper; Agent loop | One sub-run per sequence with a fresh context, same runId, summary passed back. |
| 9 | Workflow 2 Free-form | Classify question vs edit with the `fast` model; question turns get read-only tools. |
| 10 | Agent loop (run record) | Define resume of a paused run after app restart, or state it ends as `stopped`. |
| 11 | Testing | Replay recorded run records as deterministic regression fixtures. |
| 12 | Workflows; Claude Code skill | Workflow frontmatter: `allowedTools`, `roles`, `checkpoints`. |
| 13 | Workflow 1 Clipper | Filler / pause / repeat trim step with a review list. |
| 14 | Agent loop (events) | A todo/plan tool in tools mode, streamed to the activity log, one item in progress at a time. |

### (b) Wrong or risky in our spec

| Spec section | Risk | Change |
|---|---|---|
| Tools: one per engine op | Schema bloat on 32k local contexts; CapCut splits tools even for cloud models. | Workflow-scoped subsets plus progressive disclosure (a3). |
| Agent loop: compaction stubs | Old `get_sequence` results go stale after writes. | Write results return touched items' new state and version; stubs carry the version; stale ones are flagged. |
| Untrusted content / threat model | Images and frames not listed; text in images can steer the vision model. | Add an "image text" row; the vision prompt treats on-image text as content. |
| Agent loop limits (`maxStepsPerRun` 60) | 3 clips × (storyboard + 2 self-review + 2 sound passes) may hit the cap. | Per-sequence step budget, or sub-runs (a8). |
| Workflow 2 / Undo this run | No rule for user edits during a run. | Show which sequences the agent is editing; inject user edits as a change note (a1). |
| General | CapCut depends on remote prompts, tool config, models, classifiers, commerce. | Do not copy; keep prompts, tools and workflows local and versioned. |

### (c) We already match or beat CapCut

| Spec section | Ours | CapCut |
|---|---|---|
| Providers; capability probe | BYO model, local-first, per-role probe | Remote encrypted model config, cloud only |
| `undo_my_last_edit`; Undo this run | Run-scoped undo with conflict detection | Shared undo stack [I] |
| Plan mode | Deterministic execution for weak models | None found |
| Time units | ms throughout | Mixed s / µs / ms needing prompt warnings |
| Workflow checkpoints | Enforced by the loop | Prompt-only skills |
| Untrusted content | `<data>` envelope, ingest source rule, injection tests | No defence strings found [I] |
| Tool surface | No shell / file / HTTP tools | SDK compiles in filesystem, execute and web tools [I] |
| Cost, redaction, sound review | Budget cap, redactor, audio QA | Commerce pre-charge; no audio QA found [I] |
| Compaction | 70% budget, keep last 8 steps | Equivalent settings |
