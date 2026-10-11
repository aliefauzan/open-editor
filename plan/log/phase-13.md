# Phase 13 — App: agent panel + settings + v1.0

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-12 · — |
| Model | Opus 5.5 · high (phase agent, no subagents) |
| Machine | M5, macOS 27 |
| Branch | phase/13-agent-panel-v1 (worktree `.worktrees/phase-13`) |

## Pre-check
Prerequisites 10b (GATE 5 pass, D-58) and 12 are [x] (checked by the orchestrator). Owner delegation
(D-49, D-58): the AI runs gates and manual steps itself, except anything that needs a credential. No
OpenRouter key exists: every OpenRouter part of steps 6, 7 and 7b stays an open owner item in TODO; the
live checks run with the keyless providers (Apple on-device, local Ollama `qwen3.5:latest`,
`nimble:latest`). No GUI tool: in-app steps are covered by Playwright E2E against the built app.
The installed app (`/Applications/Vox Studio.app`, `~/vox-gate5`) is not touched; own tests use temp homes.

## Plan summary
1. Packaging of the agent: workflow prompts staged into Resources (`agent/workflows`, loader dir
   settable), `bin/vox-apple-llm` built by `pnpm dist` (fails without a macOS 26+ SDK) and signed
   before the app seal, `pnpm dist:no-apple`, `build-info.json` (`appleHelper`).
2. Engine host: `settings.get/save/probe` (masked keys only, Keychain, role only after a passing probe,
   cookies toggle, contact, limits) and `agent.run/runs/stop/decide/undoRun` (runWorkflow, pauses held
   in the host, events `agent.event`/`agent.todos`, run records → activity log, restart rule).
3. Quick clips: `fast` role → LLM scorer in the makeClips job; "Add style beats" → Stylize run.
4. Renderer: agent panel (chat, attachments, mode indicator, "Confirm plan first", stop, pause cards
   by kind, activity log with todos, changes, audio numbers + timecodes, "Undo this run",
   `UNDO_CONFLICT` view, "Make clips from URL"), agent-editing tab marker, Settings dialog (providers,
   keys, Test, roles with badges, limits, notes, Tools section with cookies toggle), "Open Settings"
   on the `LOGIN_REQUIRED` hint.
5. `vox self-test`: every check required (no `skipped`), Apple helper `--status` / `notBuilt`.
6. `scripts/fresh-clone-check.sh`; version 1.0.0; README + release notes; GitHub Release draft.
Test order: settings host tests (S18, S33) → agent host tests (pauses, decide, runs, restart) →
self-test tests → renderer component tests (panel, cards, settings) → E2E (mock model) → packaging.

## Checklist
- [x] 1 Settings IPC tests (S18) + host
- [x] 1b Cookies toggle (S33)
- [x] 1c self-test hard checks + packaging (`dist:no-apple`, SDK check)
- [x] 2 Agent panel component tests + UI
- [ ] 3 E2E mock agent run, Add style beats
- [ ] 3b E2E D-15 (plan card, tighten card, marker + user trim, todos)
- [ ] 4 UI gate screenshots
- [ ] 5 Full R4 pass (self-review)
- [ ] 6 MANUAL (owner, OpenRouter): make 3 vox clips in the app — keyless parts by the AI
- [ ] 7 MANUAL (owner, OpenRouter key): Settings probe + roles — Ollama/Apple parts by the AI
- [ ] 7b Deferred live checks (keyless providers by the AI; OpenRouter open)
- [ ] 8 Version 1.0.0, `pnpm dist`, release notes
- [ ] 8b Fresh-clone check
- [ ] 9 GitHub Release v1.0.0 draft (orchestrator publishes)
- [ ] 10 Owner install from the Release (orchestrator / owner)
