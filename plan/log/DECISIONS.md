# Decisions

Format: `D-NN · YYYY-MM-DD · phase · title`, then **Context**, **Decision**, **Consequences**.
Newest last. A newer decision beats older text in specs or plan files; the spec is then updated
in the same commit when the decision changes a contract.

---

## D-01 · 2026-10-10 · pre-plan · Ship as an Electron desktop app only

**Context**: The first design had a localhost web UI. The owner wants to share the tool with a friend
as a file, like the IBM project.
**Decision**: Electron app (same stack as the IBM project: electron-vite, electron-builder, React 19,
Zustand, Tailwind + shadcn/ui). No web build. Engine and agent run in a `utilityProcess`.
**Consequences**: Specs revised to Revision 3; `vox-web-design.md` replaced by `vox-app-design.md`.

## D-02 · 2026-10-10 · pre-plan · Distribute as an ad-hoc-signed arm64 `.dmg`

**Context**: No Apple Developer account. The friend may also clone the repo later.
**Decision**: `pnpm dist` builds `Vox-Studio-<version>-arm64.dmg` for macOS 14+ on Apple Silicon,
ad-hoc signed. The friend allows it once via System Settings → Privacy & Security → "Open Anyway"
(or `xattr -dr com.apple.quarantine`). Heavy tools install at first run. Update check via GitHub
Releases, no auto-update.
**Consequences**: Developer ID signing and notarization stay optional for later.

## D-03 · 2026-10-10 · pre-plan · Build order: spike, engine, styles, app core, agent, app agent

**Context**: Riskiest unknowns are HyperFrames with many video cuts, preview latency inside Electron's
security setup, and timeline library fit.
**Decision**: Phases 00–15 as in `plan/README.md` §3, with GATE 1 (spike) before any engine compile
work and GATE 4 (timeline benchmark) before the editor UI.
**Consequences**: The UI exists before the agent, so agent output can be judged visually.

## D-04 · 2026-10-10 · plan review · Accept GSAP despite its licence

**Context**: The plan review (finding #17) and the GSAP Standard License page: GSAP is free, including commercial use, but forbids "Competitive Products" ("any software, tool, or service that enables users to create, edit, or manage animations through a visual interface") without written consent.
**Decision**: The owner accepts the risk. GSAP stays vendored in builds with its notices intact. Recorded as an exception in the engine spec's "Decisions already made".
**Consequences**: If Webflow objects, templates must move to plain frame-based JS easing.

## D-05 · 2026-10-10 · plan review · ffmpeg comes from Homebrew (required)

**Context**: Review finding #19: no maintained LGPL arm64 static ffmpeg build is known.
**Decision**: First-run setup requires Homebrew + `brew install ffmpeg`. It shows the commands with copy buttons. The app never downloads or bundles ffmpeg.
**Consequences**: App goal 7 ("no terminal") is relaxed. Installing Homebrew/ffmpeg is the one terminal step, and it needs the user's admin password. The app spec "First-run setup" and phase 09 carry this edit (applied with D-08; phase 09 wording fixed with D-10).

## D-06 · 2026-10-10 · plan review · Split phase 10 into 10a and 10b

**Decision**: 10a covers the store, preview pipeline, timeline, preview controls and inspector. 10b covers the media bin, export dialog, style gallery, E2E and GATE 5. Full scope is kept (estimates were later removed, D-10).

## D-07 · 2026-10-10 · plan review · Auto mode skips gated phases; merges use --no-ff

**Decision**: While a gate is open, auto mode starts the next phase whose prerequisites are all [x]. Phases merge into main with `git merge --no-ff`, so there is no rebase and no history rewrite. The owner's gate answer arrives as a chat message "GATE n: <answer>" and is recorded as a D-NN entry.

## D-08 · 2026-10-10 · plan review · Fixes from the review (all applied, see D-09)

Applied in the review session: D-04 in the engine spec, spike limit (later attempts instead of a time-box, D-10) and outcomes for items 2 and 7, `removeMedia` never deletes files.
Applied in the next session (2026-10-10), the list below:
- track ids `V1`/`A1` exempt from R3 prefixes (#1);
- PROMPT steps 1, 9, 11 per D-07, plus the GATE 4 exception (#2, #8);
- redactor + `paths` + config module in the engine API (#6, #13);
- packaging resources list + packaging test, and an Electron fuses row in R4 (#4, #18);
- hook trust follows the template's declaring style (#5);
- PROGRESS Engine API frozen after 05 (#7);
- committed CC0 face fixtures (#9);
- sync check moves to 05 (#10);
- mock injection test (#11);
- `removeMedia` test (#12);
- hook purity by determinism (#14);
- owner inputs in TODO (#15);
- `ingest {proxies:false}` (#16);
- D-05 into app spec + phase 09;
- phase 10 split per D-06;
- LOW findings #20–#24;
- uncovered items (pdf extraction lib, context-overflow retry test, `--workflow screenplay|style-extract`, CI latency bench, keyboard tests, single owner per test);
- MediaPipe full-range check in phase 04;
- 08 pass/fail rule for the GATE 4 prototype and a skeleton `.dmg` smoke test.

## D-09 · 2026-10-10 · plan review · Choices made while applying D-08

**Decision**: These choices were made while applying the D-08 fixes. Specs, refs and phases now match them.
- The engine owns three shared modules:
  - `src/paths.ts`, published as `@vox/engine/paths`, so Electron main never imports the engine main entry;
  - `src/config.ts`, the only reader/writer of `~/.vox/config.json` (mode `0600` from the first write, patch merges);
  - `src/redact.ts`, exposed as `engine.redactor`. The agent registers key values with `addSecrets`. There is no `agent/src/redact.ts`.
- `<project>` in the CLI is a project id or a unique name; `vox undo <project>` and `vox redo <project>`.
- Encoding: proxies use libx264; render muxes the HyperFrames picture with `-c:v copy` and AAC audio.
- `.pdf` text comes from pypdf (BSD) in `py/vox_py/doctext.py`.
- `ingest({ proxies: false })` / `--no-proxies` skips proxies, thumbs and peaks (used by 15).
- Hook trust follows the style that declares the template, not the style that uses it.
- Hook purity is tested by determinism plus a static check; there is no `vm` sandbox. Trust (S8) is the boundary.
- Electron fuses: `RunAsNode` stays on, because the CLI runs with Electron as Node. Node options and inspect are off. ASAR integrity and `OnlyLoadAppFromAsar` are on (S27). App CSP includes `frame-ancestors 'none'` (S28).
- Bundled resources are listed in R1 "Packaged app"; `vox self-test --json` checks them in the built app.
- Two CC0 portraits are checked in as fixtures (R3 exception). The 90 s spike fixture gets `transcripts/spike-90s.json`.
- A/V sync is proven in 05 after the mux; 03 proves cuts and the audio-only click offsets.
- The S20 injection test runs in CI with a scripted mock model; the live eval is extra evidence.
- Each test has one owning phase: 03 owns `extends`/cycle/collision/token-scoping and the plain `TEMPLATE_VERSION` test; 06 and 07 reference it.
- Phase 10 is split into 10a and 10b (GATE 5) per D-06.

**Why**: These are the smallest choices that close review findings #1–#24 and the uncovered items without new tools or services.

## D-10 · 2026-10-10 · plan review 2 · Owner answers and second-review fixes

**Decision**: The owner answered the open questions; the second review's findings are applied with these choices.
- **Specs approved** (Revision 3). The five specs now say "approved 2026-10-10".
- **Licence**: MIT for this repo. Phase 00 adds `LICENSE`.
- **Projects folder**: `~/Movies/Vox Studio/` by default, shared by the app and the CLI, created with mode `0700`. Resolution order: `--projects-dir` flag, `VOX_PROJECTS_DIR`, `projectsDir` in `~/.vox/config.json`, the default. `vox paths [--json]` prints it with the styles folders and tool paths. The repo's `projects/` is dev scratch only.
- **Git and conflicts**:
  - bookkeeping (`plan/**`, `docs/**`, evidence) is committed on `main` in the root checkout as soon as it changes;
  - phase code lives in a worktree `.worktrees/phase-<NN>` on branch `phase/<NN>-<slug>` and never edits `plan/**` or `docs/**`;
  - before merging, the phase merges `main` into its branch inside the worktree and re-runs Verify; then `main` merges the branch with `--no-ff`, which is then conflict-free;
  - conflict rules: `pnpm-lock.yaml` and `uv.lock` take `main`'s version, then `pnpm install` / `uv lock` regenerate them; manifests and config files keep the entries of both sides; code keeps both intents; if a conflict cannot be resolved with confidence, `git merge --abort`, log it, add it to TODO and stop.
- **Optional MANUAL STEPs** (marked "optional — does not block merge") never block a merge.
- **GATE 1** is decided by its numbers, like GATE 4: items 1, 3 or 5 fail → hybrid export; items 4 or 6 fail → the app spec's pre-written "Preview fallback"; opaque sandbox fails → `allow-same-origin` fallback. Each item gets 3 measurement attempts; an unmeasured item counts as failed. The owner can still overrule later.
- **GATE 2 fallback**: if Resolve rejects the OTIO, FCPXML via `otio-fcpx-xml-adapter` (moved forward from 14g); if both fail, README steps for a manual import, tested once by the owner, pass the item.
- **No time estimates**: all day estimates and day-based time-boxes are removed from `plan/` and `docs/`. The spike uses attempts instead; GATE 3 has no iteration limit. Functional durations (timeouts, latency bars, lock waits) stay.
- **More gates**: GATE 6 (14a sheet for the 4 new templates), GATE 7 (14e clip-speed design), GATE 8 (15 blind A/B).
- **Providers**: presets for Claude (Anthropic), OpenRouter, OpenCode Zen (`https://opencode.ai/zen/v1`, OpenAI-compatible), 9router (local OpenAI-compatible gateway), LM Studio, Ollama and Apple's on-device model. `pnpm eval --provider <id>` runs the evals on any configured provider.
- **Apple on-device model** ("enable Siri"): Apple Intelligence's Foundation Models through `vox-apple-llm`, a Swift helper (`native/apple-llm/`, shipped in `<resources>/bin/`, JSON lines over stdin/stdout, guided generation via `DynamicGenerationSchema`). No key, cost 0, plan mode only; the probe decides its roles (usually `fast`, given its ~4k context). Phase 11 builds it with a fake helper for CI; phase 13 bundles it. It needs macOS 26+ with Apple Intelligence on.
- **Keys** are written to the Keychain with `security -i` (command on stdin), so they never appear in process arguments (S30).
- **Unpriced models**: a paid-provider model with no known price cannot fill a role until it is priced or marked free.
- **Second-review fixes**: `vox-runtime.js` stays frozen (motion helpers go to `styles/vox/assets/motion.js`); hooks are self-contained (vendored ESM, `ctx.readAsset`); `media.importFiles({ paths })` is test-build only; the style panel is defined in the app spec; uv runs `--frozen` with its env and cache in the tools folder; the app bundle is never written after install (S31); archive downloads get an SSRF test (S29); `.gitignore` keeps `apps/desktop/build/`.

**Why**: Owner answers on 2026-10-10 plus the second plan review (READY WITH NOTES). The fallbacks are written now so that gates can be decided from numbers in auto mode.

## D-11 · 2026-10-10 · owner request · Quick clips first, style optional, editable subtitles

**Decision**: The default flow is simple first, styled second.
- **Quick clips**: the user pastes a URL (or drops a file). The engine runs ingest → transcribe → facetrack → `quickClips` and creates `count` 9:16 sequences, each one sentence-bounded range of the source placed as a linked `V1`/`A1` pair (facetrack framing) with captions on (`base/plain`, 3 words per chunk). No scenes, transitions or overlays. Engine job kind `quickClips`, CLI `vox quick <url|path> [--count] [--length] [--render]`.
- **Moment picking**: a built-in heuristic scorer (sentence units, speech ratio, pause penalty) needs no AI key. The agent registers an LLM scorer with `engine.quickClips.registerScorer` when a `fast` model exists (any provider, incl. Apple on-device); a failing scorer falls back to the heuristic. Selection is deterministic for the same input and scores.
- **Style is optional**: in the app, "Add style" offers "Captions only" (switch style and caption preset, no AI) or "Add style beats", which runs the new agent workflow **Stylize** (agent spec 1b: clipper steps 3–6 on existing sequences, keeping the `V1`/`A1` pair, `sourceRange` and caption edits; one run, so "Undo this run" returns the plain clip). The clipper is now quick clips followed by Stylize. A user who wants no style exports the plain captioned clip.
- **Editable subtitles**: transcripts can be wrong, so every caption is editable. `setCaptions` overrides become `{ wordKey, text?, breakAfter?, startMs?, endMs? }`: `text` may hold several words (split evenly over the word's time) or `null` (hidden); `startMs`/`endMs` retime a word; `breakAfter` splits or merges chunks; removing the override resets it. The app gets a **Subtitles panel** (list of chunks, edit in place, find and replace, nudge timing, split/merge, hide, reset), each edit one undoable op.
- **Export**: `vox render --captions burn|none`; the export dialog offers subtitles burned in or not, plus SRT/VTT, all including the edits.
- **Plan placement**: engine side in 02 (override fields), 03 (`deriveCaptions` with the new fields), 05 (`quickClips`, `vox quick`, `--captions`, engine done-when 7, part of GATE 2); app side in 10b (start screen, Subtitles panel, export option, quick-clips E2E with no model; part of GATE 5); agent side in 12 (LLM scorer, Stylize) and 13 ("Add style beats" button). The quick path is part of 4-core and works with no AI key.

**Why**: The owner wants a simple path first: URL in, captioned clips out, subtitles fixable by hand, styling only if wanted. It reuses existing ops and stages, so no new contract beyond the scorer hook and the override fields.
