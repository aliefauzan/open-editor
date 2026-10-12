# Phase 13 — App: agent panel + settings + v1.0

| Field | Value |
|---|---|
| Status | merged (ee82856); Release v1.0.0 published; waiting: GUI install checks (screen locked), OpenRouter key |
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
- [x] 3 E2E mock agent run, Add style beats (`e2e/agent.spec.ts` test 1)
- [x] 3b E2E D-15 (plan card, tighten card, marker + user trim, todos) (`e2e/agent.spec.ts` tests 2–3)
- [x] 4 UI gate screenshots (`docs/evidence/phase-13/`)
- [x] 5 Full R4 pass (self-review (token budget); see "Review findings")
- [ ] 6 MANUAL (owner, OpenRouter): make 3 vox clips in the app — keyless parts done by the AI (see
      "Live checks"); the OpenRouter part and the in-app run at the screen stay open (TODO)
- [ ] 7 MANUAL (owner, OpenRouter key): Settings probe + roles — Ollama/Apple probe and roles done by the
      AI through `vox config` (same host code as the Settings screen); OpenRouter open (TODO)
- [ ] 7b Deferred live checks — keyless providers done by the AI (phase 11 and 12 logs); OpenRouter open
- [x] 8 Version 1.0.0, `pnpm dist`, release notes (`docs/release-notes/v1.0.0.md`)
- [x] 8b Fresh-clone check (PASS, see "Verify results")
- [x] 9 GitHub Release v1.0.0 (published by the orchestrator): draft created by the AI (target `f808c24`, asset `Vox-Studio-1.0.0-arm64.dmg`
      196822622 bytes, SHA-256 `0b1b8e14…f68d56c`); the orchestrator publishes it
- [~] 10 Owner install from the Release: CLI stand-in done (checklist below); GUI checks open

## Files created / changed
- Engine host (`apps/desktop/src/engine-host/`): `settings.ts` (new: settings IPC, Keychain, probes, roles,
  limits, cookies, contact), `agent.ts` (new: runs, pauses, decide, undo, run data with change notes),
  `e2e-agent.ts` (new: mock model, test builds only), `handlers.ts`, `index.ts`, `quick.ts` (fast-role scorer).
- Main: `protocol.ts` (`resolveMediaPathSettled`), `index.ts`; shared `api.ts` (settings/agent methods).
- Renderer: `Settings.tsx` (new), `editor/AgentPanel.tsx`, `agent-store.ts`, `SequenceTabs.tsx` (marker),
  `QuickStart.tsx`, `TopBar.tsx`, `NextSteps.tsx`, `MediaBin.tsx`, `context.tsx`, `ui-store.ts`, `App.tsx`.
- Packaging: `scripts/build.ts` (Electron binary fetch), `stage-resources.ts` (workflows, Apple helper),
  `after-pack.cjs` / `after-sign.cjs` (helper signing and checks), `electron-builder.yml`, `package.json`
  (`dist:no-apple`); bundled CLI `src/cli/vox.ts`.
- Agent: `loop/run.ts` (change-note lines), `loop/plan.ts` (pictures inside arrays, dropped beats,
  misfit scenes as placeholders, empty-plan hint), `loop/types.ts`,
  `workflows/stylize.ts`, `workflows/clipper.ts`, `workflows/load.ts` (`setWorkflowsDir`),
  `providers/factory.ts` (Ollama base64), `evals/run.ts` (Apple helper).
- CLI: `config.ts`, `main.ts`, `self-test.ts` (required checks, Apple helper status).
- Engine: `ops/scenes.ts`, `ops/items.ts` (end snapped on its own); version 1.0.0 everywhere.
- `scripts/fresh-clone-check.sh` (new), README; ROOT: `docs/release-notes/v1.0.0.md`, `docs/evidence/phase-13/`.
- Tests: `e2e/agent.spec.ts` (new), `test/engine-host/agent.test.ts`, `settings.test.ts`,
  `test/renderer/agent-panel.test.tsx`, `quick.test.tsx`, `test/main/protocol.test.ts`,
  `test/setup/apple-sdk.test.ts`, `packaging.slow.test.ts`; agent `plan.test.ts`, `run.test.ts`,
  `stylize.test.ts`, `load.test.ts`, `factory.test.ts`; CLI `self-test.test.ts`; engine `addScene.test.ts`,
  `assets-jobs.test.ts`; replay fixture `stylize-tools.json` re-recorded (it had recorded the OVERLAP bug).

## Live checks (steps 6, 7, 7b; keyless providers only)
Owner delegation (D-49, D-58): run by the AI with a temp `VOX_HOME`; no OpenRouter key exists, so every
OpenRouter part stays open in TODO. No GUI tool: the in-app flows are covered by the E2E (mock model) and
the live runs used the `vox` CLI, which runs the same engine and agent code as the engine host.
- Step 7 (probe + roles): `vox config probe` (the runner the Settings "Test" button calls) for
  `ollama:qwen3.5:latest`, `ollama:nimble:latest` and `apple:apple-on-device`; roles set with
  `vox config` to editor `ollama:qwen3.5:latest` (plan mode), fast `apple:apple-on-device`. Table in
  `plan/log/phase-11.md` "Phase 13 step 7b". The probe found an Ollama vision crash (fixed).
- Step 7b (evals): `pnpm run eval --mode plan` with all roles on qwen3.5, with editor qwen3.5 + fast
  Apple, and with Apple only. Tables in `plan/log/phase-12.md` "Phase 13 step 7b". At the branch head
  (editor qwen3.5, fast Apple) every checkpoint is met on all three inputs and the injection case
  passes; the speaker share stays above the vox range (model quality, not a checkpoint).
- Step 6 / 7b real URL: `vox agent <p> "make 3 vox clips from https://www.youtube.com/watch?v=rtcMRI3ARck"
  --workflow clipper --mode plan --count 3 --yes`: run 4 completed, 3 clips, 18/18 checkpoints, $0
  (`run_GtSHi9bmV9rz`). Runs 2 and 3 failed on plan-mode bugs that are now fixed (see phase 12 log).
  Audio QA reports `sfxUnderSpeech` with LISTEN timecodes on all three clips (check by ear).
- Not done (needs a person at the screen or a key): the agent panel run in the installed app, the
  OpenRouter probe, roles, evals and tools-mode URL run (TODO).

## Verify results (branch head, 2026-10-12)
| Command | Result |
|---|---|
| `pnpm test` | 2482 passed, 0 failed, 1 skipped (2483 tests, 667 files) |
| `pnpm lint` · `pnpm typecheck` | clean · clean |
| `pnpm -C apps/desktop e2e` | 10 passed, 1 skipped (`@local` unseeded quick path), 3.1 min; agent spec 3/3 |
| `pnpm dist` | 44 s (warm); `Vox-Studio-1.0.0-arm64.dmg` 187.7 MB, app 509 MB, `build-info.json` `{"version":"1.0.0","appleHelper":true}`, `codesign --verify --strict` ok |
| packaged `vox self-test --json` (temp HOME, `PATH=/usr/bin:/bin`) | ok, 10/10 passed, none skipped |
| `VOX_SLOW=1` `test/packaging.slow.test.ts` | 7 passed |
| `bash scripts/fresh-clone-check.sh` | PASS at `2536691`: clone 2 s, `pnpm install --frozen-lockfile` 2 s (warm store), `pnpm dist` 37 s; `.dmg` 192 MB; self-test ok, every check passed |
| App test video (packaged CLI `vox quick https://www.youtube.com/watch?v=rtcMRI3ARck --count 3`, temp HOME) | exit 0, 322 s: 3 clips (37.5 s, 46.6 s, 31.5 s) from 558 candidates, heuristic scorer (no fast role in the temp home) |

## Done when
- [ ] 2 "make 3 vox clips" from the agent panel: the same run passed through the CLI on the owner's URL
      (Ollama plan mode, 3 clips, all checkpoints met); the panel flow passed in the E2E with the mock
      model (`e2e/agent.spec.ts` test 1: live edits, Undo this run, MP4 + SRT export). The in-app run
      with a real model at the screen is open (TODO).
- [ ] 3 OpenRouter key + Ollama model: Ollama probed and roles assigned (phase 11 log); key storage is
      covered by `test/engine-host/settings.test.ts` (S18: masked only, Keychain). OpenRouter open (no key).
- [ ] Deferred live checks (7b): keyless parts pass except the speaker-share quality; OpenRouter open.
- [x] 4 main / engine-host security tests pass (`pnpm test` above); R4 review: see "Review findings".
- [x] D-15 E2E (step 3b): `e2e/agent.spec.ts` tests 2 and 3 pass.
- [x] `vox self-test --json`: ok, no `skipped` (packaged app and fresh clone).
- [x] 5 (v1 part) style gallery: `docs/evidence/phase-13/` screenshots show `base` and `vox` with the
      agent panel present; the 10b gallery tests pass in `pnpm test`.
- [ ] 6 fresh-clone check passes (above); the owner install from the Release is step 10 (open).
- [x] v1.0 recorded in PROGRESS and DECISIONS (D-59).

## Review findings
self-review (token budget): one pass over the phase diff for code quality and the R4 rows that the
phase touches (S1, S17, S18, S32, S33, S34, D-15 rows).
- No CRITICAL or HIGH finding.
- Checked: the E2E mock model exists only in unpackaged `VOX_E2E` builds; keys are write-only over IPC
  and only the masked form returns; a base URL with credentials is refused (S17); the `vox-media://`
  retry calls `resolveMediaPath` again for each try, so the root check (S1) still applies; no
  `dangerouslySetInnerHTML`; no secret, personal path or e-mail in the diff.
- MEDIUM, fixed: the stylize storyboard checkpoint counted a user trim during the run as a miss
  (found by E2E test 3); a rebuild swap gave the player a 404 (E2E console); Settings did not close on
  Escape when focus was outside the dialog (screenshot spec).
- LOW, open: `nimble:latest` fails the vision probe (text-only model; the probe reports it correctly);
  the Apple scorer failed with `SensitiveContentAnalysisML error 15` on the real URL and the heuristic
  scorer took over (owner item).

## Deviations
- Steps 6, 7, 7b ran with the keyless providers only and through the CLI, not the app window (owner
  delegation; no key, no GUI tool). OpenRouter parts are TODO items, not passes.
- Fixes outside the phase's own files, found by the live checks: engine `addScene`/`addItem` end
  snapping, agent plan executor (nested slots, dropped beats, misfit placeholders, empty-plan hint),
  Ollama base64, eval runner Apple helper, `scripts/build.ts` Electron fetch. All in D-59.

## MANUAL STEPS
1. (Owner, key) Settings → OpenRouter key → Test → roles; then `pnpm run eval --provider openrouter`
   and the tools-mode URL run (TODO).
2. (At the screen) In the installed 1.0.0 app: agent panel → "Make clips from URL" with the test video →
   3 tabs, play, trim, export one (TODO).
3. (Orchestrator) Publish the draft Release v1.0.0.
4. (Owner, step 10) Install from the Release page following the README only; fill the checklist below.

## Owner install (step 10) checklist
Done by the orchestrator on 2026-10-12 (owner delegation, D-58). The screen was locked, so the GUI could
not be captured or driven; each stand-in is named below. The GUI items stay open.
- [~] Downloaded `Vox-Studio-1.0.0-arm64.dmg` from the published Release: fetched with `curl`, not a
      browser (the built-in browser pane does not save downloads). Size 196822622 bytes and SHA-256
      `0b1b8e14…f68d56c` match the Release asset. A `com.apple.quarantine` attribute was set by hand to
      stand in for the browser one.
- [~] Copied to `/Applications` from the mounted .dmg (`ditto`, not a Finder drag); quarantine carried
      over and `spctl` rejected the app ("no usable signature"), as expected for an ad-hoc build. The
      README Terminal step (`xattr -dr com.apple.quarantine`) cleared it; `codesign --verify --strict` ok.
      "Open Anyway" in Privacy & Security not tried (screen locked).
- [~] Launched with `open -a` (default homes). Not a fresh home: `~/.vox` and the default tools dir
      already existed. On launch the app re-synced the Python env (new `.vox-src-hash` stamp, D-57).
      Setup screen not seen. Installed `vox doctor --quick`: every check ok; `vox self-test`: every
      check ok (incl. apple-helper ready, 52 agent tools).
- [~] Quick clip from the test URL (`https://www.youtube.com/watch?v=rtcMRI3ARck`) with the installed
      build's own CLI (`Contents/Resources/cli/vox quick … --count 1 --length 30-60 --render`), not the
      GUI: exit 0, 4:27 wall (05:57:16 to 06:01:43), heuristic scorer. Clip 1 = 122.7–160.2 s of the
      source; MP4 1080x1920, 30 fps, 37.5 s, -14.1 LUFS, cropdetect full frame (no bands), captions
      burned (mono, keyword bold) and an SRT. Evidence: `docs/evidence/phase-13/10-installed-quick-clip-sheet.jpg`,
      `10-installed-quick-clip.srt`.
- [x] GUI, 2026-10-12 13:09-13:21 (screen unlocked; driven by the orchestrator with background
      accessibility control), installed 1.0.0 app started with a fresh home (`VOX_HOME`, `VOX_TOOLS_DIR`,
      `VOX_PROJECTS_DIR` set to new empty folders). Setup screen showed 3 missing tools (deno, yt-dlp,
      Python environment); Install all finished in about 2.5 min (13:10:19 to about 13:12:40) and the app
      went to Quick clips. Quick clip from the test URL with count 1, 30-60 s: done in under 5:20 (13:13:02
      start; editor open by 13:18:19) at load average 14-23 (another session's five agents running).
      Play works; captions show (mono, keyword bold); 9:16 with no bands. Export (MP4 + SRT, Standard,
      burned subtitles, YouTube loudness) finished by 13:21:23; the export audio check passed (loudness
      -14.1 LUFS, target -14). The MP4 is 1080x1920, 30 fps, 37.5 s, H.264/AAC. Evidence:
      `docs/evidence/phase-13/10-gui-quick-clip-sheet.jpg`.
- [~] GUI Settings: the provider pop-up menu could not be driven in the background, so `ollama` and
      `apple` were added and the roles set with the installed CLI on the same home (editor and vision
      `ollama:qwen3.5:latest`; the fast role stays empty because `apple-on-device` failed the probe's plan
      check). The app showed them after reopening Settings, and its Test button on the Ollama model gave
      tools, loop and vision ok, plan failed, context 32,768.
- [x] GUI agent panel, 2026-10-12 14:14-14:44 (screen unlocked again), same fresh home. The panel kept
      showing "no model" after the roles were set from the CLI until the app was restarted (Settings showed
      them at once); after a restart it showed `qwen3.5:latest · plan`. New empty project, "Make clips from
      URL" (prefills "Make 3 clips from "), the test link, Send. The run asked three times to approve the
      pause cuts (one list per clip; Apply pressed each time with the default ticks), then finished:
      clipper done, $0.00, 3 steps, 20 timeline changes, tabs Clip 1-3. Clip 3 played (mono-box captions).
      Trim by hand: the inspector Out point of clip 3's first video item changed 65700 to 64700; history
      v21 `trimItem` by `user` (31500 to 30500 ms; the linked audio item changed with it). Export of Clip 3
      (MP4 + SRT, Standard): 1080x1920, 30 fps, 31.5 s (a V2 placeholder scene runs to 31.5 s), -14.0
      LUFS. Seen: the MP4 is 181 MB (46 Mb/s) where the plain quick clip is 5.5 Mb/s at the same quality;
      the CLI render of the agent's clip 3 was 49 Mb/s. Scenes are mostly placeholders (plan mode, small
      local model).
- [~] Agent stand-in (screen locked), same fresh home, installed 1.0.0 CLI: `vox agent <p> --workflow clipper
      --count 3 --length 30-60 --yes-sources --yes` with editor `ollama:qwen3.5:latest` (plan mode), no fast
      model (heuristic scorer). Exit 0 in 18:04 (13:50:46 to 14:08:50, cost $0), 3 clip sequences, each
      tightened (9, 14, 11 pauses). Clip 1: 4 scenes (3 placeholder), Audio QA fail (sfxUnderSpeech),
      -14.13 LUFS. Clip 2: 9 scenes (7 placeholder), Audio QA fail (sfxUnderSpeech), -14.09 LUFS. Clip 3:
      4 scenes (4 placeholder), Audio QA pass, -13.84 LUFS. Clip 3 rendered (standard) in 90 s: 1080x1920,
      30 fps, 22.8 s, -13.8 LUFS, captions styled, paper-tear edges; the scene pictures are placeholders,
      as the handoff note expects for plan mode with a small local model. Evidence:
      `docs/evidence/phase-13/10-agent-clip3-sheet.jpg`. Trim in the GUI is not covered.

## Handoff notes
- Phase 14 (Claude Code skill): `workflows/*.md` are staged into `Resources/agent/workflows`; call
  `setWorkflowsDir` when loading them from another place.
- Plan mode with small local models: most scenes end up as placeholders (no image queries) and the
  speaker share stays high; a cloud model is expected to do better (to check with the OpenRouter evals).
- The Apple on-device model is usable only as `fast`; its scorer can fail on some transcripts
  (`SensitiveContentAnalysisML error 15`), and the heuristic scorer takes over.
- Phase 15: the release is ad-hoc signed, not notarized (README Gatekeeper steps).
