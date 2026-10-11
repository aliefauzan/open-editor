# Phase 13 — App: agent panel + settings + v1.0

| Field | Value |
|---|---|
| Track | app |
| Prereq | 10b (GATE 5), 12 |
| Spec § | app "Screens" (agent panel, settings), "Engine-host API" (agent, settings), "Error handling" (`UNDO_CONFLICT`), "Testing" (E2E with mock agent, settings tests), "Done when" 2–4, 6 |
| Model | Sonnet 5.5 · high |
| Gate | **v1.0** release check (fresh-clone check + owner's Release install; friend optional, D-16) |
| Next | 14, 15 |

## Goal

The agent works from the app: paste a URL, ask for 3 vox clips, watch the edits land live on the
timeline, approve sources, stay within budget, undo a run. Then ship v1.0 as a `.dmg` anyone can
install from the README, or build from a GitHub clone (D-16).

## Required reading

- App spec "Main editor" agent panel bullets, "Settings", "Engine-host API" agent + settings rows, "Done when".
- Agent spec "Agent loop" events, "Configuration and keys"; R4 rows S18–S20, S32, S33 and the full table
  (final pass); DECISIONS D-12 (self-test), D-13, D-14, D-15; phase 11 and 12 handoff notes.

## Output

- **Agent panel**: chat thread with attachments (media thumbnails, documents); model/mode indicator
  (tools/plan); "Confirm plan first" toggle beside the mode indicator (`agent.run` with `confirmPlan`;
  D-15); stop button; pause cards ("wants to ingest `<source>` — Allow / Deny", "Budget reached
  ($2.00) — Continue with $X / Stop"); an `approval` pause gets one card per `kind` (D-15): `source` →
  the ingest card, `plan` → the **plan card** (the `ClipPlan` per sequence, each beat with time range,
  template or speaker, and text; "Run plan" / "Stop" via `agent.decide`), `pauses` → the **tighten
  review** card (the `removePauses` dry-run list in the "Pauses & fillers" form from 10b: tick/untick,
  seek on click, "Apply" / "Skip"; the pause carries `ranges: { wordKey, kind: 'pause' | 'filler' |
  'repeat', seqStartMs, seqEndMs, text }[]` per sequence; "Apply" sends `agent.decide(runId, { approve:
  true, wordKeys })` with the ticked keys (all keys = whole list), "Skip" sends empty `wordKeys`);
  per-run collapsible activity log from run records ("Analyzed", "Edited in timeline (n changes)" with clickable changes, job progress, cost, skipped steps, audio check
  numbers and the five `LISTEN.md` timecodes (each seeks the preview; D-14), "Undo this run"); in tools
  mode the run's todo list sits at the top of the log, redrawn on each `agent.todos` event (`done` ticked,
  the one `in_progress` highlighted, `pending` plain; D-15); quick action "Make clips from URL"; input
  with file drag-and-drop.
- Quick clips (from 10b) gain the agent: with a `fast` model the LLM scorer picks moments; the "Add style
  beats" button runs Stylize (12) on the clip and shows it as one run with "Undo this run" (D-11).
- Agent edits arrive with an "agent" badge through the existing store; selection passed as context.
- **Editing-by-agent marker** (D-15): sequence tabs named in the latest `agent.step` `scope` (a
  sub-run's sequence, or all of the run's) show an "agent editing" marker, cleared on `agent.done`. The
  user may still edit them; the agent sees those edits in its next change note.
- A run that was paused when the app quit shows as `stopped` after relaunch, with "Undo this run" (D-15).
- `UNDO_CONFLICT` view listing conflicting items, each clickable.
- **Settings**: providers from the presets (Claude (Anthropic), OpenRouter, OpenAI, Gemini, OpenCode Zen,
  9router, Ollama, LM Studio, Apple on-device, OpenAI-compatible with base URL); Apple on-device shows
  its `--status` availability and needs no key;
  write-only masked key input → Keychain, "Test" (probe results), role assignment with capability badges,
  budget limits, per-provider note that project content is sent to it; Tools section (setup status,
  "Update yt-dlp", repair, Commons contact, "Use browser cookies for Instagram/TikTok" toggle with a
  browser picker, off by default; only this toggle or `vox config set` in a terminal writes
  `ingest.cookiesFromBrowser`, S33). The
  `LOGIN_REQUIRED` hint on the start screen (10b) gets an "Open Settings" link to this toggle.
- `window.vox.agent.*` and `settings.*` wired to the engine host.
- `bin/vox-apple-llm` bundled (`extraResources`, built in `pnpm dist` with `swift build -c release`;
  ad-hoc signed in `afterSign`). `pnpm dist` (the release build) fails if no macOS 26+ SDK is found
  (D-16). A builder without the SDK runs `pnpm dist:no-apple`: no helper, `build-info.json` records
  `appleHelper: false`, and Settings hides the Apple provider; the README names both scripts.
  `vox self-test --json` also runs `vox-apple-llm --status` (any status passes; a missing or crashing
  helper fails when `appleHelper` is true; with `appleHelper: false` the check reports `notBuilt: no
  macOS 26+ SDK`, which passes and is not `skipped`). Every self-test check that 09 allowed to report
  `skipped` is now required (D-12): a `skipped` result fails.
- `scripts/fresh-clone-check.sh` (D-16): `git clone` of the repo into a temp folder, `pnpm install
  --frozen-lockfile`, `pnpm dist`, then `vox self-test --json` on the built app; prints JSON plus a
  one-line summary for the log.
- E2E extended with the mock agent path; final R4 security pass; `v1.0.0` release notes.

## Steps

1. [ ] Settings IPC tests: only masked keys reach the renderer; a masked save keeps the Keychain key;
       key never in project files, logs or renderer (canary) (S18); a model that failed a role's probe
       cannot be assigned in the UI; the Apple row shows each `--status` value (fake helper).
1b. [ ] Cookies toggle (S33): off by default; turning it on writes `ingest.cookiesFromBrowser` through
        `settings.*` only; no agent tool and no project file can set it (agent tool snapshot from 11 and a
        config write spy); "Open Settings" from a `LOGIN_REQUIRED` hint focuses the toggle.
1c. [ ] `vox self-test --json` on the built app: every check passes and none reports `skipped` (D-12).
        Packaging test (D-16): a `pnpm dist:no-apple` build has no helper, `build-info.json` says
        `appleHelper: false`, self-test reports `notBuilt: no macOS 26+ SDK` and passes, and Settings hides
        the Apple row; `pnpm dist` with the SDK path faked away fails with a clear message.
2. [ ] Agent panel component tests: event stream → activity log; pause cards → `agent.decide`; stop;
       audio check numbers and timecodes render, and a timecode click seeks the preview. D-15: one card per
       pause `kind` (`source`, `plan`, `pauses`); the tighten card renders `ranges` and sends the ticked
       `wordKeys` (all, a subset, or empty for Skip); the "Confirm plan first" toggle sends `confirmPlan`; the
       todo list redraws on `agent.todos` with at most one item highlighted; the sequence-tab marker
       follows `agent.step` `scope` and clears on `agent.done`.
3. [ ] E2E (mock model): agent run makes edits that appear live → source-approval pause → undo run →
       export draft MP4 + SRT with correct duration (completes the app spec E2E list). Also: "Add style
       beats" on a quick clip (mock model) → scenes appear → "Undo this run" returns the plain clip.
3b. [ ] E2E (mock model, D-15): "Confirm plan first" on → plan card shows before any edit; "Stop" leaves
        `history.list` unchanged; "Run plan" applies it. Clipper tighten card: untick one range → "Apply" →
        one undo entry per sequence, the unticked pause stays. During a run, the marked sequence tab
        accepts a user trim, and the next `agent.step` change note (run record) lists it. The todo list
        shows in the activity log.
4. [ ] UI gate screenshots of agent panel and settings against the reference layout.
5. [ ] Full R4 pass with security-reviewer, including S32 (export targets) and S33 (cookies opt-in); fix
       CRITICAL/HIGH.
6. [ ] MANUAL STEP (owner): in the app, paste a real YouTube URL, "make 3 vox clips" with OpenRouter →
       3 sequence tabs, each previewable, editable by hand and exportable (app done-when 2).
7. [ ] MANUAL STEP (owner): Settings with an OpenRouter key + an Ollama model, probe, assign roles
       (app done-when 3).
   7b. [ ] Deferred live checks (D-44), right after step 7 with the keys entered there: phase 11 MANUAL
       STEPS 1–2 (`vox config probe --json openrouter:<id> ollama:<model>`, other providers optional) and
       phase 12 steps 9–10 (live `pnpm eval` per provider; real URL in OpenRouter tools mode and Ollama
       plan mode). Record the results in the phase 11 and 12 logs.
8. [ ] Version `1.0.0`; `pnpm dist`; release notes with the Gatekeeper steps.
8b. [ ] Fresh-clone check (automated, D-16): `bash scripts/fresh-clone-check.sh` passes; summary in the log.
9. [ ] MANUAL STEP (owner): publish the GitHub Release `v1.0.0` with the `.dmg` (repo in TODO).
10. [ ] MANUAL STEP (owner, own account, D-16): download the `v1.0.0` `.dmg` from the Release page in a
        browser (real quarantine), install it following the README only, and export one clip; fill the
        checklist in the log (time taken, where you got stuck). A friend's install is optional and, if
        done, goes in the same checklist.

## Verify

```bash
pnpm test
pnpm -C apps/desktop e2e
pnpm dist
bash scripts/fresh-clone-check.sh   # clone → install → dist → self-test (D-16)
```

## Done when (= app done-when 2, 3, 4, 6; 1 and 7 from phase 10b; 5 partly here, Part C in 15)

- [ ] 2 "make 3 vox clips" from the agent panel → 3 tabs, previewable, editable, exportable.
- [ ] 3 OpenRouter key + Ollama model added, probed, roles assigned; key only in the Keychain.
- [ ] Deferred live checks of phases 11 and 12 (step 7b) pass (D-44).
- [ ] 4 all main / engine-host security tests pass; full R4 table green (incl. S32, S33 and the D-15
      rows).
- [ ] D-15 agent panel E2E (step 3b) passes: plan card, tighten card, sequence-tab marker, todo list.
- [ ] `vox self-test --json` passes with no `skipped` check (D-12).
- [ ] 5 (v1 part) regression check: the style gallery (built and tested in 10b) still shows `base` and
      `vox` with the agent panel present.
- [ ] 6 the fresh-clone check passes, and the owner installed the Release `.dmg` following the README and
      exported a clip (D-16; a friend's install is optional).
- [ ] v1.0 recorded in PROGRESS and DECISIONS.

## Risks and fallback

| Risk | Fallback |
|---|---|
| User's Mac lacks disk space for models (~3+ GB with tools) | Setup screen shows sizes up front; README states requirements |
| Live edits flood the UI during a big `batch` | Batch is one change set; UI applies it once |
| The owner's account already has tools and models, so the Release install hides first-run problems | The 09 clean-install test (temp `VOX_HOME`, `VOX_TOOLS_DIR`, no Homebrew on `PATH`) covers first run; the owner's install covers download, quarantine and README wording (D-16) |

## Handoff notes

- v1.1 (phase 14) and Part C (phase 15) are independent; either can go first.
