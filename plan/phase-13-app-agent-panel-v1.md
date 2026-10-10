# Phase 13 — App: agent panel + settings + v1.0

| Field | Value |
|---|---|
| Track | app |
| Prereq | 10b (GATE 5), 12 |
| Spec § | app "Screens" (agent panel, settings), "Engine-host API" (agent, settings), "Error handling" (`UNDO_CONFLICT`), "Testing" (E2E with mock agent, settings tests), "Done when" 2–4, 6 |
| Model | Sonnet 5.5 · high |
| Gate | **v1.0** release check (friend install) |
| Next | 14, 15 |

## Goal

The agent works from the app: paste a URL, ask for 3 vox clips, watch the edits land live on the
timeline, approve sources, stay within budget, undo a run. Then ship v1.0 as a `.dmg` a friend can
install from the README.

## Required reading

- App spec "Main editor" agent panel bullets, "Settings", "Engine-host API" agent + settings rows, "Done when".
- Agent spec "Agent loop" events, "Configuration and keys"; R4 rows S18–S20 and the full table (final pass).

## Output

- **Agent panel**: chat thread with attachments (media thumbnails, documents); model/mode indicator
  (tools/plan); stop button; pause cards ("wants to ingest `<source>` — Allow / Deny", "Budget reached
  ($2.00) — Continue with $X / Stop"); per-run collapsible activity log from run records ("Analyzed",
  "Edited in timeline (n changes)" with clickable changes, job progress, cost, skipped steps, "Undo this
  run"); quick action "Make clips from URL"; input with file drag-and-drop.
- Quick clips (from 10b) gain the agent: with a `fast` model the LLM scorer picks moments; the "Add style
  beats" button runs Stylize (12) on the clip and shows it as one run with "Undo this run" (D-11).
- Agent edits arrive with an "agent" badge through the existing store; selection passed as context.
- `UNDO_CONFLICT` view listing conflicting items, each clickable.
- **Settings**: providers from the presets (Claude (Anthropic), OpenRouter, OpenAI, Gemini, OpenCode Zen,
  9router, Ollama, LM Studio, Apple on-device, OpenAI-compatible with base URL); Apple on-device shows
  its `--status` availability and needs no key;
  write-only masked key input → Keychain, "Test" (probe results), role assignment with capability badges,
  budget limits, per-provider note that project content is sent to it; Tools section (setup status,
  "Update yt-dlp", repair, Commons contact).
- `window.vox.agent.*` and `settings.*` wired to the engine host.
- `bin/vox-apple-llm` bundled (`extraResources`, built in `pnpm dist` with `swift build -c release`; skipped
  with a warning when the macOS 26 SDK is missing, README states the requirement;
  ad-hoc signed in `afterSign`); `vox self-test --json` also runs `vox-apple-llm --status` (any status
  passes; a missing or crashing helper fails).
- E2E extended with the mock agent path; final R4 security pass; `v1.0.0` release notes.

## Steps

1. [ ] Settings IPC tests: only masked keys reach the renderer; a masked save keeps the Keychain key;
       key never in project files, logs or renderer (canary) (S18); a model that failed a role's probe
       cannot be assigned in the UI; the Apple row shows each `--status` value (fake helper).
2. [ ] Agent panel component tests: event stream → activity log; pause cards → `agent.decide`; stop.
3. [ ] E2E (mock model): agent run makes edits that appear live → source-approval pause → undo run →
       export draft MP4 + SRT with correct duration (completes the app spec E2E list). Also: "Add style
       beats" on a quick clip (mock model) → scenes appear → "Undo this run" returns the plain clip.
4. [ ] UI gate screenshots of agent panel and settings against the reference layout.
5. [ ] Full R4 pass with security-reviewer; fix CRITICAL/HIGH.
6. [ ] MANUAL STEP (owner): in the app, paste a real YouTube URL, "make 3 vox clips" with OpenRouter →
       3 sequence tabs, each previewable, editable by hand and exportable (app done-when 2).
7. [ ] MANUAL STEP (owner): Settings with an OpenRouter key + an Ollama model, probe, assign roles
       (app done-when 3).
8. [ ] Version `1.0.0`; `pnpm dist`; release notes with the Gatekeeper steps.
9. [ ] MANUAL STEP (owner + friend): friend follows the README from download to first exported clip on
       their Mac; owner fills the checklist in the log (time taken, where they got stuck).
10. [ ] If a repo exists (TODO): MANUAL STEP (owner) publishes a GitHub Release with the `.dmg`.

## Verify

```bash
pnpm test
pnpm -C apps/desktop e2e
pnpm dist
```

## Done when (= app done-when 2, 3, 4, 6; 1 from phase 10b; 5 partly here, Part C in 15)

- [ ] 2 "make 3 vox clips" from the agent panel → 3 tabs, previewable, editable, exportable.
- [ ] 3 OpenRouter key + Ollama model added, probed, roles assigned; key only in the Keychain.
- [ ] 4 all main / engine-host security tests pass; full R4 table green.
- [ ] 5 (v1 part) style gallery shows `base` and `vox`.
- [ ] 6 a friend followed the README to a first exported clip.
- [ ] v1.0 recorded in PROGRESS and DECISIONS.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Friend's Mac lacks disk space for models (~3+ GB with tools) | Setup screen shows sizes up front; README states requirements |
| Live edits flood the UI during a big `batch` | Batch is one change set; UI applies it once |

## Handoff notes

- v1.1 (phase 14) and Part C (phase 15) are independent; either can go first.
