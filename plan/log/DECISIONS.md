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

## D-12 · 2026-10-10 · plan review 3 · Third-review fixes

**Decision**: The third plan review (READY WITH NOTES, 18 findings) is applied with these choices.
- **Repo hosting**: `aliefauzan/open-editor` on GitHub (the existing `origin`). The phase-09 update check uses its Releases. TODO "Before phase 00" is ticked.
- **Commons contact** moves from "Before phase 00" to the inputs needed by phase 05, the only phase that sends it. Without it, Commons requests are throttled to 10/min (engine spec), so phase 05 does not block on it.
- **Mid-phase MANUAL STEP** (PROMPT step 6g): auto mode marks the phase `[~] waiting: manual <step>` in PROGRESS, writes the request to TODO "Manual steps", finishes every step that does not depend on the manual one, and goes on with the next phase whose prerequisites are `[x]`. `done: <item>` resumes it.
- **Phase 09 self-test**: each check runs only when its module is in the build (`vox` style → 07, workflow prompts → 12, `agent/prices.json` → 11) and reports `skipped: <reason>`; phase 13 turns every check into a hard requirement. Phase 09 keeps its prerequisites (05, 08).
- **py-env resync**: setup stores the SHA-256 of the bundled `uv.lock` in `<tools>/py-env/.vox-lock-hash`; `vox doctor` and the setup screen compare it on launch and re-run `uv sync --frozen --no-editable` on a mismatch (needed when 14d or 15 add Python packages in an app update).
- **Phase 07 keeps prerequisite 05**: the side-by-side sheet uses `vox frames`, `render` and `assets cutout`, which phase 05 builds. The edge stays; the owner's GATE 2 actions are batched in TODO so they come early.
- **GATE 1 wording**: the preview fallback is used when item 4 fails in both sandbox modes or item 6 fails (engine spec "Spike"), not when item 4 fails only in opaque mode.
- **Gallery** is owned by 10b; 13 only re-checks it (regression).
- **Phase 14** sub-phases each get their own Verify block, and PROGRESS gets a Prereq column.
- **Smaller fixes**: `--no-sync` and `UV_PYTHON_INSTALL_DIR` in the 04 bridge and R3; reveal allow-list in 10b matches the app spec (`renders/` or a dialog path); 12 Verify split into mocked (auto) and live (MANUAL STEP); screenplay fixture generator in 14b; tests for `--playlist`, empty archive search and `vox preview`; `NO_HANDLES` re-tested with the real registry in 03; S8 test named in 15; packaging smoke render owned by 10b; engine folder tree lists `runs/` and `logs/`; overview says steps 7 and 8 run in either order.

**Why**: Third plan review on 2026-10-10. Two HIGH findings blocked auto mode (TODO gate, phase 09 self-test); the rest were drifts between specs and phases.

## D-13 · 2026-10-10 · owner request · Links from Instagram/TikTok, uploaded files, export to a chosen folder

**Decision**:
- **Input**: the user pastes a public YouTube, Instagram (reel, post) or TikTok link, or picks/drops a video they already downloaded. All links use the existing yt-dlp path through the filtering proxy; `sources.ts` only classifies the URL for a badge and hints. The yt-dlp format choice changes from `height<=1080` to `-S "res:1080"`, so vertical 1080×1920 videos keep full quality; `--playlist-items 1` takes the first video of a carousel unless `--playlist`.
- **Login walls**: public posts need no account. A login-walled, private or rate-limited post fails with `LOGIN_REQUIRED` and a hint to drop the file instead. An opt-in setting `ingest.cookiesFromBrowser` (off by default; Safari/Chrome/Firefox) passes `--cookies-from-browser`; only the user sets it (S33).
- **Export target**: every export can go to a file or folder the user picks. CLI: `-o` / `--out-dir` (and `vox quick --out-dir`). App: "Save to" row in the export dialog; one file → save dialog, several → folder picker; default = last folder for this project, else `~/Movies`. The renderer never sends a raw path: main opens the dialog and returns a `targetId` the engine host maps to the path for this session. The agent has no export tool. Writes are temp + rename; no silent replace (S32).
- **Placement**: engine in 04 (sources, argv, `LOGIN_REQUIRED`, cookies opt-in) and 05 (export targets, `EXPORT_PATH`, GATE 2 adds one Instagram and one TikTok ingest); app in 10b (start-screen badge and "Choose file…", export dialog "Save to") and 13 (cookies toggle in Settings); agent in 11 (tool-list check).

**Why**: Owner request 2026-10-10: input by URL (YouTube, Instagram, TikTok) or an already-downloaded file, and export to a path the user selects.

## D-14 · 2026-10-10 · owner request · Sound design: real SFX, timeline cues, audio QA

**Decision**: Adopt the approach of the article "Sound design for Opus 5.5: no more cheap beeps" (0xCodila, 2026-10-09) as our own feature. No code or files from its `opus-sound-layer` repo are used; its licence is unknown. If code is ever reused, its licence is checked first and recorded in R5.
- **Real recordings only**: style SFX are CC0 or recorded for the project, never synthesised; each has a type (`cut`, `move`, `land`, `appear`, `hero`), a source and a licence in `style.json` and `assets/sfx/CREDITS.md`. `vox style validate` runs a kit check (not a pure tone, one event, not a noise bed, clean edges, peak, length) and writes a sheet image.
- **Cues from the timeline**: compile writes `build/<seq>/audio/cues.json` from template and transition `sfxCues` at the item's own times; cues closer than 120 ms, or hero cues closer than 4 s, are dropped and listed. Template cue times are checked against measured motion in rendered frames. Scenes get `sfxOff` to mute single cues.
- **Audio QA**: `vox audio-qa` (job `audioQa`, `py/vox_py/audioqa.py`, numpy + ffmpeg) renders stems and the mix and checks cue timing, one event per cue, spacing, SFX under speech and loudness (−14 LUFS ±1, ≤ −1 dBTP). It writes `qa.json`, `qa.png` and `LISTEN.md` (five timecodes for a human ear check). Thresholds sit in one file and are never loosened to pass. The mix gets two-pass `loudnorm`.
- **Agent**: a `check_audio` tool; clipper and Stylize run a sound review after the frame review, fix FAILs through ops (at most 2 rounds), and report the numbers and timecodes without ever calling the sound good.
- **App**: the export dialog shows the audio check and the listen timecodes as seek buttons; the inspector lists a scene's cues with mute toggles.
- **Placement**: 02 (`sfxOff`), 03 (cue list, stems, `loudnorm`), 05 (audio QA tool and CLI, bad-sample fixtures), 06 (kit check in `validate`, new `sfx` format), 07 (`vox` kit of real recordings, cue timing, GATE 3 adds the owner's ear check), 10a (inspector cues), 10b (export audio check), 11 (`check_audio`), 12 (sound review in the workflows).

**Why**: Owner request 2026-10-10. A model cannot hear its own audio, so sound has to be placed from measured events and checked by numbers plus a picture, and a person does the final ear check.

## D-15 · 2026-10-10 · competitor teardown · Changes from the CapCut 9.4.1 analysis

**Decision**: Adopt the changes found by the static teardown of CapCut 9.4.1
(`docs/research/2026-10-10-capcut-engine-teardown.md`, `…-capcut-agent-teardown.md`). The contracts
are not frozen yet (phase 02 freezes them), so `schemaVersion` stays 2 and no migration is needed.
Nothing from CapCut is copied: no code, prompts or assets; only ideas. Names and defaults below are
binding for the specs and phase files.

Engine — time and media:
- **Frame rates**: `canvas.fps` becomes a rational `{ num, den }` from a fixed set: 24/1, 25/1, 30/1,
  60/1, 24000/1001, 30000/1001, 60000/1001. `ms(f) = Math.round(f * 1000 * den / num)`,
  `frame(ms) = Math.round(ms * num / (1000 * den))`. Times stay integer ms. Quick clips and the clipper
  use the source's rate when it is in the set, else the nearest. `inMs` is snapped to the **source**
  frame grid (`MediaItem.fps`), timeline times to the sequence grid.
- **VFR sources**: ingest detects variable frame rate (ffprobe `r_frame_rate` ≠ `avg_frame_rate`, or a
  pts-delta spread over 1 frame). A VFR video gets a constant-frame-rate copy `media/<id>.cfr.mp4`
  (`MediaItem.cfrPath`, `vfr: true`); preview and render use it instead of the original. The spike
  fixture set adds a VFR phone-style clip.
- **Per-source loudness**: ingest measures each audio-bearing source (`ebur128`) into
  `MediaItem.loudness { integratedLufs, truePeakDb }`. Compile applies a gain-to-target per audio clip
  before `amix`, so sources at different levels match; the final two-pass `loudnorm` stays.
- **Export loudness target**: `render --loudness youtube|tiktok|broadcast` = −14 / −12 / −23 LUFS,
  default `youtube`. Audio QA checks against the chosen target ±1 LU (the threshold file stores the
  tolerance, not the target; this is not a loosening).
- **Denoise**: `MediaClip.denoise?: 'off' | 'light' | 'strong'` (default `off`), ffmpeg `afftdn`
  (built in). No RNNoise model files in v1.
- **Speech gate**: `transcribe` runs Silero VAD (MIT, ONNX through `onnxruntime`, no torch) first.
  The `silero-vad` pip package pulls in torch, so its ONNX model is vendored at
  `py/vox_py/models/silero_vad.onnx` with its licence and a SHA-256 in R5.
  Words outside speech regions are dropped; Whisper segments with `no_speech_prob > 0.6` or
  `compression_ratio > 2.4` are dropped. The transcript stores `speechRegions: {startMs, endMs}[]`;
  the quick-clips speech ratio uses them.
- **Word kinds**: transcript words get a computed `kind: 'word' | 'pause' | 'repeat' | 'filler'`
  (filler list per language in `engine/src/text/fillers.ts`; repeat = 1–3-word n-gram repeated
  back to back; pause = a gap ≥ `minPauseMs` stored as a pseudo-word). Whisper is prompted with an
  `initial_prompt` that contains fillers; the spike measures whether fillers survive.
- **Shot detection**: new stage and job kind `shots`, CLI `vox shots <project> <mediaId>`, writes
  `shots/<mediaId>.json` = `{ startMs, endMs }[]` using ffmpeg `scdet` (threshold 10, i.e.
  `scene > 0.35` equivalent) on the proxy. TransNetV2 (MIT) is the documented fallback if the fixture
  test misses cuts; it is not built in v1. `vox quick` and the clipper run it after ingest.

Engine — framing:
- `frame.mode` adds `'auto'` (face → body → saliency → centre). `frame` gains
  `stability?: 'locked' | 'smooth' | 'follow'` (default `smooth`), `trackSpeed?: 'slow' | 'normal' |
  'fast'` (default `normal`) and `keyframes?: { atMs, x, y, scale }[]` with `atMs` relative to the
  item start (moving an item keeps them; trims shift them). In `manual` mode the keyframes are the
  crop; in `facetrack`/`auto` they are user overrides that pin the track and blend back over 300 ms.
- **Facetrack** samples at 12 fps on a 360p proxy, resets smoothing at shot boundaries, keeps the
  current subject unless another face is > 30% larger for ≥ 1 s (hysteresis), and falls back to
  Apple Vision attention saliency (`VNGenerateAttentionBasedSaliencyImageRequest` via
  `pyobjc-framework-Vision`, MIT; now a v1 dependency, not only Part C) for shots with no face.
  `locked` = one static crop per shot when the subject stays inside a 10% dead zone. Output is
  `{ atMs, x, y, scale }` keyframes; compile emits them as a CSS `transform` (translate + scale), not
  `object-position`. Cache key = (media hash, aspect, mode, stability, trackSpeed).
- **No proxy**: `shots` and `facetrack` read the original scaled to 360p when a media item has no
  proxy (styles Part C ingests with `{ proxies: false }`).
- **Default framing**: quick clips and the clipper place `V1` with `auto` framing; `facetrack` always
  runs, since `auto` needs its body and saliency fallback.
- **NTSC check**: spike item 9 renders the fixture at 30000/1001. If HyperFrames cannot render a
  fractional rate frame-exactly, GATE 1 records it, `canvas.fps` keeps only integer rates and NTSC
  sources conform to the nearest integer rate through the CFR copy.

Engine — captions:
- Define `CaptionChunk { startMs, endMs, lines: { words: CaptionWord[] }[] }` and
  `CaptionWord { key, text, startMs, endMs, emphasis: boolean }`. Times are timeline ms; presets
  get the word times, so they can style read / active / unread words (karaoke).
- `CaptionTrack` gains `maxLines` (default 1), `maxCharsPerLine` (default 18) and `gapFillMs`
  (default 400: a chunk's end extends to the next chunk's start when the gap is shorter; each word's
  end extends to the next word's start inside a chunk). `autoEmphasis?: boolean` (default false)
  marks numbers and capitalised non-initial words.
- Overrides gain `emphasis?: boolean`. Overrides are stored as their own history entities
  `captionOverride:<seqId>/<wordKey>`; `captions:<seqId>` holds the track fields only. Word edits then
  record one small entity and `undoRun` conflicts are per word.
- Caption presets (styles) gain `case: 'asis' | 'upper' | 'lower'`, `stripPunctuation: boolean` and
  `safeArea { bottomPct, rightPct }` (default 20 / 12 on 9:16); these live in the preset, not the track.

Engine — ops and history:
- **New ops**: `removePauses { sequenceId, minPauseMs = 350, keepMs = 80, kinds = ['pause'] }`
  (kinds may add `'filler'`, `'repeat'`) and `removeWords { sequenceId, wordKeys[] }` (text-based
  cutting). Both expand to one `batch` of `rippleDelete` ranges over linked V and A items, so the
  whole removal is one undo entry, and both have `dryRun: true`, which returns the ranges without
  applying (the review list).
- **Partial tighten**: `removePauses` takes optional `wordKeys?: string[]`. When given, only the
  pause, filler and repeat ranges whose word keys are listed are removed, still with `keepMs` at each
  edge. A ticked subset of the review list is applied as `removePauses { wordKeys }`, not
  `removeWords`.
- **Coalescing**: `applyOp(..., { coalesceKey })`. A new entry with the same `coalesceKey`, actor and
  `runId` within 1 s of the previous one replaces that entry's `after` and keeps its `before`.
- **Job results**: a job that writes to the model records `baseVersion` at start and applies its
  result as one `batch` with a `jobId` on the history entry. Entity conflicts since `baseVersion`
  fail with `JOB_CONFLICT` (listing keys) instead of overwriting. "Undo quick clips" is one entry.
- **Write result**: every `applyOp` returns `{ version, changes, results: { op, status:
  'succeeded' | 'failed' | 'conflicted', items?: Item[] }[] }` (touched items' new state).
- **Compact view**: `engine.view(projectId, sequenceId)` returns flat `items[]` `{ id, track, startMs,
  endMs, kind, text | template | mediaId }`, caption chunk text and `version`. The agent reads this,
  not the full project.
- **Schema safety**: on load, `schemaVersion > supported` fails `SCHEMA_TOO_NEW` and never writes.
  Before a load-time migration, the engine writes `snapshots/auto-pre-migrate-v<N>.json`.

Engine — quick clips:
- Boundaries: a clip starts 120 ms before its first word (never inside the previous word) and never
  within 2 frames before a shot cut (it moves to the cut). Clip edges are trimmed of pauses.
- Heuristic scorer adds no-AI signals: energy (loudness variance), hook (first sentence is a question
  or holds a number), coverage (a face on screen, from facetrack). `quickClips` takes
  `prompt?: string`, passed to a registered scorer; the heuristic ignores it.
- Stylize and the clipper default to cover-style transitions at clip edges (no handles there).

Engine — preview:
- **Pre-render cache** (conditional): if the spike's preview fps margin on heavy scenes is under 20%,
  the app background-renders scene instances with `renderLayers` into `cache/prerender/<hash>.mp4`
  keyed by the instance file hash, and the player mounts the cached clip. GATE 1 records the margin.

Styles:
- Template rules gain optional `minEntranceMs`: below it, the entrance animation is skipped.
- Caption presets get the fields above and must render read / active / unread word states.

Agent:
- **Tool surface**: each workflow declares `allowedTools` (clipper ≈ 12 core tools). The rest are
  reachable through a `describe_tool { name }` / `call_tool { name, args }` pair. The capability probe
  measures the token cost of the tool list per role and fails a role whose tool list takes > 25% of
  its context.
- **Workflow frontmatter**: `allowedTools`, `roles`, `checkpoints`.
- **Short ids**: per-run aliases (`c1`, `s1`, `m1`) for items, sequences and media, resolved by the
  engine side of the tool layer; an unknown alias returns `UNKNOWN_ALIAS` with a re-read hint.
- **Fresh state every step**: each step injects the compact `view` of the sequences in scope and a
  "Changes since your last step" note built from history entries with `actor` ≠ `agent` (or another
  run) after the last version the run saw. Write results carry the new version; compaction stubs
  carry the version they read; a stub older than the current version is marked stale.
- **Robust tool calls**: repair malformed tool-call JSON before zod; detect a tool call written as
  plain text and inject one correction; an identical repeated call gets a note on the 2nd time and
  pauses the run with `error` on the 3rd.
- **Time frames**: `get_transcript` and `view_frames` return paired `srcMs` and `seqMs`; every time
  field's name says its frame.
- **Frame health**: model-free checks (mostly black, mostly white, blank, low luma) on review frames,
  run even with no vision model.
- **Plan confirm**: `vox agent --confirm-plan` and an app toggle show the ClipPlan and wait for OK.
- **Sub-runs**: the clipper and Stylize run one sub-run per sequence with a fresh context, the same
  `runId` and a summary passed back. `maxStepsPerRun` (60) applies per sub-run.
- **Intent gate**: free-form turns are classified question vs edit with the `fast` role; a question
  gets read-only tools.
- **Restart**: a run that was paused when the app quit ends as `stopped` on next launch; its edits
  stay and "Undo this run" still works.
- **Replay tests**: recorded run records replay as deterministic regression fixtures.
- **Todo tool**: in tools mode, `update_todos` keeps a short plan (one item in progress) streamed to
  the activity log.
- **Pause trim**: the clipper adds a "tighten" step: `removePauses` dry run → review list (checkpoint
  in the app, auto-apply in CLI with `--yes`) → apply.
- **User edits during a run**: the app marks sequences the agent is editing; user edits there are
  allowed and reach the agent as the change note.
- **Threat model**: on-image text (frames, archive images, thumbnails) is untrusted content; the
  vision prompt says text in images is content, never instructions; an injection eval adds an image
  case.

App:
- Sliders and text fields send ops with `coalesceKey`; the Subtitles panel gets "Pauses & fillers"
  (dry-run list, tick/untick, apply) and word delete → `removeWords`; the inspector framing section
  gets mode `auto`, stability, track speed and "Pin frame here" (adds a keyframe at the playhead);
  the agent panel gets the "Confirm plan first" toggle and the editing-by-agent marker on sequence tabs.

Deferred (backlog, not v1/v1.1): music bed with beat-snapped cuts (librosa), TransNetV2, RNNoise.

**Why**: The CapCut teardown found real gaps (NTSC/VFR sources, reframe drift at cuts, no
pause/filler removal, an undefined `CaptionChunk`, tool-schema bloat on small local contexts, stale
reads after compaction) and patterns worth copying. Where our design already beats CapCut
(run-scoped undo, derived captions, crash-safe history, injection defence, local models) it stays.

## D-16 · 2026-10-10 · plan review 4 + owner answers · Fixtures, gates, release checks

**Decision**: The owner answered the review questions on 2026-10-10: the M5 runs macOS 27.0.1 with
Xcode 27.0 (macOS 27 SDK; command-line tools also hold the 26.5 SDK), checked on the machine; "do the
best" for the rest; no friend's Mac and no second account are required, as long as people can clone
the repo from GitHub or install the shared `.dmg`. The AI chose the following; names are binding.

Fixtures:
- **Checked-in seed media**: `talking-head-20s.mp4`, `.mov` and `.webm` are generated once by
  `make.sh --seed-media` in phase 00 on the M5 and committed to
  `packages/engine/test/fixtures/assets/media/` (≤ 5 MB each). `make.sh` no longer rebuilds them by
  default. Everything keyed by media hash (`transcripts/talking-head-20s.json`, seeded
  `shots/<mediaId>.json` and `facetracks/<mediaId>.json`, the `VOX_E2E=1` seeds, the offline project)
  uses these committed files, so the hashes match on every Mac and on CI. A seed manifest
  `fixtures/assets/media/SEEDS.json` lists each file's SHA-256; a fast test fails if a file and the
  manifest differ. Tests on other generated fixtures assert tolerances, never exact bytes or exact
  `say` timings.
- **`tap.wav`**: fetched in phase 00 together with the portraits: one real tap or knock recording
  from Wikimedia Commons (CC0 or public domain; no account needed), trimmed with 5 ms fades, URL in
  `LICENSES.md`. Phase 00 step 10 is the one network step for checked-in fixtures (portraits + tap).
- **`vox` SFX kit (07)**: the AI sources real recordings from Wikimedia Commons (CC0 / public domain)
  first. Freesound needs a login, so a Freesound file is used only if the owner downloads it (optional
  MANUAL STEP). The GATE 3 ear check decides.
- **`make.sh` extension steps** are explicit: phase 05 adds the audio QA set (R7).

Graph and gates:
- **10a prerequisites are 06 and 09** (was 07 and 09). The editor core needs the style format and
  `base`, not the `vox` sheet, so the app track no longer waits on GATE 3. The `vox` style is still in
  v1: 12 needs 07, and 13 needs 12 and checks the gallery shows `base` and `vox`.
- **GATE 3 and GATE 6 exit**: after 3 rounds without approval, the AI asks the owner to choose:
  (a) keep iterating, or (b) accept the style as the v1 look, with the open notes written to the phase
  log as backlog. The AI never accepts on its own.
- **GATE 2 platform fallback**: if a YouTube, Instagram or TikTok ingest fails because of the platform
  (the failure stays after `yt-dlp -U`; yt-dlp version and stderr recorded), GATE 2 can pass for that
  platform when the same video as a local file passes, and the link fails with `LOGIN_REQUIRED` or
  another `VoxError` with a clear hint. It is logged as a known issue and checked again at GATE 5.
- **Gate inside a phase** (GATE 4 in 08): handled like a mid-phase MANUAL STEP (D-12). The AI finishes
  the steps that do not depend on it, marks `[~] waiting: GATE <n>`, and does not merge.

Release checks:
- **Apple helper**: the helper needs the macOS 26 SDK or newer (Foundation Models). The M5 has the
  macOS 27 SDK, so phase 11 builds `vox-apple-llm` and `pnpm dist`
  always bundles it; `pnpm dist` fails if no macOS 26+ SDK is found. The Xcode licence must be accepted
  once (`sudo xcodebuild -license`, owner) before `swift build` works. A builder who clones the repo without the
  SDK runs `pnpm dist:no-apple`: no helper, `build-info.json` says `appleHelper: false`, `vox self-test`
  reports `notBuilt: no macOS 26+ SDK` (a pass, not `skipped`), and Settings hides the Apple provider.
- **No second account, no friend**: install checks run on the owner's own account.
  - 09: an automated clean-install test: the `.dmg` gets a quarantine attribute, the app is copied to
    a temp folder, `spctl --assess` is recorded (expected: rejected, which is why the README shows
    "Open Anyway"), and setup runs with temp `VOX_HOME` and `VOX_TOOLS_DIR` and a `PATH` without
    Homebrew (the ffmpeg-missing view shows). The owner opens the app once through "Open Anyway" for
    the README screenshots (optional; does not block merge).
  - 10b (GATE 5): the owner does the E2E path and the real-URL quick clips by hand on their own account
    with a fresh `VOX_HOME`.
  - 13 (v1.0): an automated fresh-clone check (`git clone` into a temp folder, `pnpm install
    --frozen-lockfile`, `pnpm dist`, `vox self-test --json` on the built app). The owner downloads the
    `v1.0.0` `.dmg` from the GitHub Release in a browser (real quarantine), installs it following the
    README, and exports one clip. A friend's install is optional.
- **CI**: every push runs the fast suite (typecheck, lint, vitest, fast pytest, replay fixtures, mock
  injection). The slow suite (render, Electron E2E with seeded fixtures, latency bench as a warning)
  runs on `workflow_dispatch` and once a week. Tests tagged `local` (mlx-whisper, real MediaPipe,
  Apple helper, real Keychain, live providers) never run on CI; local Verify on the M5 is the merge gate.
- **Test URLs**: in phase 05 the AI proposes public candidate URLs (the owner's own posts first, else
  videos with a reuse licence) in TODO; the owner confirms. Keys stay the owner's.

Smaller fixes: 14b runs `pnpm exec tsx scripts/make-screenplay-set.ts` from the repo root (R1);
`logs/engine.log` rotation (5 MB, 3 files) is built and tested in 02; the Playwright pin is set in 08;
the engine spec repository layout lists `src/render/`, `src/export/`, `src/net/` and `src/errors.ts`
like R1; phase 04 step 4 is tagged S3; phase 07's prereq reads "05 (GATE 2), 06".

Deferred (backlog, not v1/v1.1), from the teardown and not in D-15: chapter ids so a long video gives
one clip per chapter; laughter / applause as an energy signal in the quick-clips heuristic; merging ops
into action-enum agent tools.

**Why**: Fourth plan review on 2026-10-10. One HIGH finding (seed hashes of machine-dependent
fixtures) and several gaps that auto mode could read two ways; the owner removed the friend and
second-account requirements.

## D-17 · 2026-10-10 · phase 00 · Frame counter is a binary barcode; tooling pins

**Decision**: Homebrew ffmpeg 8.1.2 on the M5 has no `drawtext` filter (built without libfreetype), so the
burnt-in frame counter of the generated fixtures (`spike-source-1080p`, `phone-vfr-20s`, `ntsc-2997-20s`)
is a 16-bit binary barcode drawn with `geq`, not text. Position: top-left at (40, 40), 16 cells of 40 px
(640 x 40), most significant bit first, white = 1, black = 0, value = zero-based frame index of the
encoded video (`N`). Decode by sampling each cell's centre (`make.sh` fixture tests do this). Phase 01
reads it by pixel sampling instead of OCR. The flash frames remain a 160 px white box at the bottom-right
on every 60th frame; the click track fires on the same frames (period 2 s, or 60 x 1001/30000 s for NTSC).
Other phase-00 choices: TypeScript 6.0.3 exact (typescript-eslint 8.71 supports only `<6.1`; revisit when
it supports TS 7); test tiers by file name (`*.slow.test.ts` with `VOX_SLOW=1`, `*.local.test.ts`);
the VFR fixture needs `-enc_time_base 1/90000` (else x264 snaps pts to 1/30 s); `transcripts/speech-fillers.json`
timings are estimates placed inside `silencedetect` speech regions (`say` has no word timestamps).

**Why**: `drawtext` is unavailable and installing a different ffmpeg build would break "Homebrew ffmpeg
only" (D-05). A barcode is easier and more reliable to read than OCR.

## D-18 · 2026-10-11 · phase 02 · Contract details fixed while building the model, ops and history

**Context**: Phase 02 freezes `project.json`, the ops, `HistoryEntry`, `ApplyResult`, `engine.view` and
the path rule (R2). The spec names every op but not all argument shapes, and a few behaviours were open.
**Decision** (engine spec "Edit operations", "History", "Write order", "Error handling" updated):
- **Op arguments**: the exported zod schema `<opName>Args` in `src/ops/` is the contract; the spec gains
  an "Arguments" list. New op `updateClip` (a media clip's `frame`, `motion`, `volume`, fades,
  `denoise`): sliders and framing in the inspector need it and the table had no op for it.
  `setCaptions` overrides are upserted by `wordKey` with field merge; `resetWords` removes them.
  `rippleDelete` takes a `trackId` and also cuts linked items' tracks; scenes in a cut range are
  shortened. `onOverlap: 'insert'` splits items spanning the insert point.
- **`ApplyResult`**: each `results[]` entry may carry `report` (op output: `ranges` for
  `removePauses`/`removeWords`, `droppedVariables`, `clamped`, new `sequenceId`); `items` are entities
  `Item & { trackId }`. `undo`, `redo` and `undoRun` also return an `ApplyResult`; nothing to undo or
  redo throws `NOTHING_TO_UNDO` / `NOTHING_TO_REDO`.
- **`VoxError`** gains optional `details` (structured data: conflicting `keys`, `itemIds`, `trackId`,
  matching project ids). Validation codes: `VALIDATION`, `NOT_FOUND`, `OVERLAP`, `MEDIA_BOUNDS`,
  `TRACK_KIND`, `MEDIA_IN_USE`, `TRACK_NOT_EMPTY`, `TEMPLATE_UNKNOWN`, `TEMPLATE_INCOMPATIBLE`,
  `VARIABLES_INVALID`, `DURATION_BOUNDS`, `SFX_UNKNOWN`, `PATH_INVALID`; plus `SNAPSHOT_EXISTS`,
  `SCHEMA_UNSUPPORTED` (older schema with no migration step), `PROJECT_NOT_FOUND`, `PROJECT_AMBIGUOUS`.
- **Ids**: prefix + 8 base-36 time digits + 4 random (`p_`, `m_`, `seq_`, `it_`, `ln_`), so they sort by
  creation; `project.json` stores `media` and `sequences` sorted by id (normalise/denormalise order).
- **History**: the `project` entity holds `id`, `name`, `meta` without `updatedAt` (stamped on every
  write, never undone), so unrelated edits never conflict on `project`. Rotation moves all but the
  newest 500 entries into `history/<firstVersion>.jsonl.gz`, so undo keeps working across a rotation.
- **Projects**: `createProject` writes version 0 with no sequence and an empty history; `vox new` adds
  its 9:16 sequence with one `addSequence` op (actor `cli`). `deleteProject` takes the lock and removes
  the project folder. Snapshot names are `[A-Za-z0-9._-]`, never replaced (`SNAPSHOT_EXISTS`).
- **Captions default** `position.yPct` 75 until phase 03's preset supplies it.

**Why**: Smallest choices that keep the phase-02 done-when and give phase 03, 04, 08 and 11 one stable
target. Nothing here changes a frozen contract.

## D-19 · 2026-10-11 · orchestration · Early start of independent steps from later phases

**Context**: The owner asked (2026-10-11) not to leave the machine idle while phases 01 and 02 run:
steps of later phases whose real inputs already exist should start now.
**Decision**: Steps that need nothing from an unfinished phase run early as "work packages", each in
its own worktree `.worktrees/early-<id>` on branch `early/<id>`:
- P1 · 04 Python tools (`vad`, `transcribe`, `facetrack`, `doctext`, vendored Silero VAD);
  P2 · 05 audio QA tool + `make.sh` audio set; N1 · 11 Apple helper (`native/apple-llm`) + fake helper;
  U1 · 08 GATE 4 timeline benchmark (Chromium first, re-run in Electron by 08); A1 · 03/07 fonts,
  Natural Earth data, `geo.search`, `vox` asset candidates; G1 · 11 pure agent utilities.
- E1 · 04 net proxy + URL classes + yt-dlp argv; E2 · 04 config, redactor, job runner, Python bridge;
  E3 · 04 media safety/analysis + 05 export target; E4 · 04 shots + facetrack path builder;
  E5 · 03 style schema/registry/tokens. E-packages use a temporary `src/errors.pending.ts` shim with
  phase 02's `VoxError` signature and merge only after 02 is on main (shim swapped for `errors.ts`).
- Packages never wire into `api.ts` and never touch files owned by a running phase. Each records what
  it did in an "Early steps" section of `plan/log/phase-<NN>.md`; the owning phase then skips those
  steps, wires them in and still runs its full Verify, review and done-when.
**Consequences**: More parallel agents share CPU; timed measurements take `.git/vox-bench.lock`. Phase
prerequisites in README §3 are unchanged for the phases as a whole.

## D-20 · 2026-10-11 · phase 04 (early E2) · Config patch, redactor, job runner and Python bridge details

**Context**: Early package E2 (D-19) builds phase 04's `config.ts`, `redact.ts`, `jobs.ts` and `py.ts`.
The spec fixes their purpose but leaves some behaviour open.
**Decision**:
- **Config**: `writeConfig(patch)` applies a JSON merge patch (RFC 7396): objects merge, `null` removes a
  key (so `ingest.cookiesFromBrowser: null` and an absent key both mean "off"), arrays and scalars
  replace (a `providers` writer sends the whole list). Unknown keys are kept (loose schema);
  `__proto__`/`constructor`/`prototype` keys are skipped. `projectsDir` must be absolute. A missing file
  reads as `{}`; unreadable or broken JSON or a wrong type fails with `CONFIG_INVALID` (no file text in
  the error) and nothing is written. Writes are serialised in-process and across processes by
  `config.json.lock` (`O_EXCL`, owner token; stale when its pid on this host is dead, after 30 s, or
  after 2 s when it has no readable owner; `CONFIG_LOCKED` after 40 s). `readConfig`/`writeConfig` are
  async.
- **Redactor**: replacement text `[REDACTED]`. Header lines `Authorization`, `Proxy-Authorization`,
  `x-api-key`, `x-goog-api-key`, `api-key`, `x-auth-token`, `Cookie`, `Set-Cookie`; query values `key`,
  `api_key`/`apikey`, `access_token`, `refresh_token`, `client_secret`, `token`, `password`; object
  keys with those names (case, `-`, `_` ignored) plus `secret` are replaced whole. Registered values
  shorter than 8 characters are ignored; each value's URL-encoded and JSON-escaped forms are
  registered too. `redact` returns a copy (arrays, plain objects, Map, Set, Errors with message, stack,
  cause and details; other class instances as they are) and never throws. `engine.redactor` is one
  shared instance (`createRedactor()` for tests).
- **Jobs**: FIFO; a GPU job waiting for the GPU does not block CPU jobs behind it; `gpu` may be a
  function of the args. A running job turns `cancelled` only when its handler settles (child gone), so
  the slot is never over-booked. Non-`VoxError` failures become `JOB_FAILED`. Event payloads (results
  included), stored errors and progress messages are redacted; stored results are not (they are data).
  Additions beyond the spec: `wait(jobId)` and `kinds()`.
- **Python bridge**: uv runs in its own process group; cancel sends SIGTERM to the group, SIGKILL after
  2 s; groups still alive when the engine process exits are killed. The child gets an allow-listed
  environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `TZ`, `LC_*`, `UV_*`, `HF_*`,
  `VOX_*`, proxy and CA variables, `XDG_CACHE_HOME`), so provider keys never reach a tool. The stderr
  tail (40 lines) excludes JSON progress lines and is redacted line by line. Tool names match
  `^[a-z_][a-z0-9_]*$`; stdout is capped at 64 MiB. Test tool `py/vox_py/_echo.py` (not used by the app).
- **New error codes** (appended to `ERROR_CODES` at the shim swap): `CONFIG_INVALID`, `CONFIG_LOCKED`,
  `JOB_FAILED`, `PY_TOOL_FAILED`, `PY_OUTPUT_INVALID`, `TOOL_MISSING`, `CANCELLED`.

**Why**: Smallest choices that satisfy S17/S19 and the phase-04 step 1–3 tests; RFC 7396 is the
standard way to say "replace only the keys named" and to remove a key. Review (typescript-reviewer,
security-reviewer) asked for the lock token, the env allowlist and the never-throwing redactor.

## D-21 · 2026-10-11 · phase 04 (early P1) · Python tool details: pins, face tiles, word clipping, tool protocol

**Context**: Early package P1 (D-19) builds `py/vox_py/{vad,transcribe,facetrack,doctext}.py`. Running
them on the fixtures showed two facts the spec guessed, and left some formats open.
**Decision**:
- **Word drop rule (spec change)**: mlx-whisper starts the first word after a pause early and ends the
  last word late (on `speech-fillers.wav`, "The" at 4000 ms while speech starts at 4194 ms; "It" 430 ms
  early), so the literal midpoint rule dropped real words. Each word is now clipped to the speech
  region it overlaps most, and a word that overlaps no region by at least 40 ms (or its whole length,
  if shorter) is dropped. Hallucinated words over music or silence overlap no region and are still
  dropped; clipped times also make the pauses `computeWordKinds` finds match the real silences. The
  segment rule (`no_speech_prob > 0.6` or `compression_ratio > 2.4`, strict) is unchanged.
- **MediaPipe pin 1.0.0**: 1.0.1 aborts in `FaceDetector` on macOS ("Check failed: service_ Service is
  unavailable", Metal helper in `TensorsToDetectionsCalculator`), with either delegate; 1.0.0 and
  1.1.0 work. 1.0.0 is pinned (all Python pins are releases at least two weeks old). The detector
  runs with the CPU delegate.
- **Full-range model kept, with tiles**: the full-range `.tflite` loads in Tasks 1.0.0 (so step 11
  needs no short-range fallback), but the detector squeezes the whole frame into its input, so at
  360p the small face of `face-2people.mp4` (about 30 px) is missed on the full frame. `facetrack.py`
  also runs the detector on three square tiles along the long side (start, middle, end) and merges
  overlapping boxes (IoU > 0.3, or the smaller box ≥ 60 % inside the larger; the larger box is kept).
  Both faces are then found on 60/60 samples.
- **"360p"** means the short side is 360 px (a 9:16 proxy samples at 360×640), both sides even.
- **Vision**: `VNDetectHumanRectanglesRequest` with its default upper-body mode (full-body mode found
  no box on the portrait fixtures); saliency = union of the attention request's salient objects.
- **Detections file** (`facetracks/<mediaId>.json`, R2): `{ sampleFps, width, height, durationMs,
  faceModel { name, sha256 }, samples: { atMs, faces, bodies, saliency | null }[] }`; a box is
  `{ x, y, w, h, score }` normalised 0–1, origin top-left; `atMs = round(i * 1000 / sampleFps)`.
- **Tool protocol**: request fields are checked (unknown field, wrong type → `INVALID_REQUEST`); on
  failure the last stderr line is `{"error": {"code", "message"}}` and the exit status is 1, stdout
  empty. While a tool runs, fd 1 points at stderr, so library output can never corrupt the result.
  Codes: `INVALID_REQUEST`, `INPUT_NOT_FOUND`, `MEDIA_UNREADABLE`, `TOOL_MISSING`, `MODEL_MISSING`,
  `MODEL_HASH_MISMATCH`, `VISION_FAILED`, `DOC_UNREADABLE`, `DOC_ENCRYPTED`, `TOOL_FAILED`. The engine
  maps them to `PY_TOOL_FAILED` with the code in the message (or its own codes) when it wires the
  tools. Schemas: `py/tests/schemas/<tool>.{request,result}.json`, `error.json`, `progress.json`.
- **Inputs from the engine**: `transcribe` takes `fillers` (the engine passes `FILLERS.en`; the prompt
  is the list joined, e.g. "Um, umm, uh, …, mhm.") and an optional `modelPath`; `ffmpeg`, `ffprobe`
  and `formatWhitelist` are request fields (default: `PATH` and the mp4/mov/matroska/webm/wav/aiff/
  mp3/flac/ogg demuxers), so the engine passes its resolved tool paths and the detected type.
- **Model files**: Silero VAD vendored (D-15). The face model and the Whisper weights are not
  vendored: `facetrack` takes `faceModelPath` and checks its SHA-256; `transcribe` without
  `modelPath` fetches the pinned revision into the Hugging Face cache and checks the weights'
  SHA-256 on every run. Where the app keeps them (tools dir) and the size prompt belong to 04/09.
- **cryptography 50.0.1**: pypdf needs it to open AES-encrypted PDFs (an empty user password is
  common in exported PDFs); without it `doctext` fails with `TOOL_MISSING`.
- **Platform**: `py/pyproject.toml` sets `tool.uv.environments` to macOS arm64 only (mlx, Vision).

**Why**: Smallest changes that make the D-15 fixture tests pass on real models; the clipping rule
keeps the spec's intent (no invented words over music or silence) without losing real first words.

## D-22 · 2026-10-11 · phase 11 (early N1, D-19) · Apple helper protocol details

**Context**: The agent spec fixes the helper's request (`{ system, messages, schema?, maxTokens,
temperature }`), its answers (`{ text }` or `{ json }` plus `{ usage }`) and the `--status` values, but
not the exact line shapes, the error line, the usage fields, line splitting or which JSON Schema
keywords survive. Early package N1 builds `native/apple-llm` and the fake helper now, so phase 11's
`apple.ts` gets one fixed target. Facts measured on the M5 (macOS 27.0, Xcode 27.0, Swift 6.4).
**Decision** (agent spec "Apple on-device model" updated):
- **Lines**: request `{ id?, system, messages: [{ role: 'user'|'assistant', content }], schema?,
  maxTokens, temperature }`; the last message must be from the user; unknown fields are rejected;
  `maxTokens` is a positive safe integer (the helper caps it at the context size). `id` is optional
  and echoed on the answer. Answers: `{ id?, text, usage }`, `{ id?, json, usage }` or
  `{ id?, error: { code, message } }`, one stdout line per request, in request order.
  `usage` is `{ inputTokens, outputTokens, estimated }`. The zod schemas in
  `packages/agent/src/providers/apple-protocol.ts` are the contract; zod, the Swift helper and the
  fake reject the same cases (shared table `test/helpers/apple-cases.ts`).
- **Line splitting**: lines end at `\n` only. Every writer (`encodeAppleRequest`, the helper, the
  fake) escapes U+2028/U+2029; readers split with `JsonLineSplitter` (same module), never
  `node:readline`, which also splits on U+2028/U+2029 and `\r`. A lone surrogate escape (valid JSON,
  valid in JS strings) becomes U+FFFD in the helper instead of failing the line.
- **Error codes**: `badRequest` (invalid line or schema), `unavailable` (status not `ready`, read
  per request; also the framework's assets-unavailable error), `contextOverflow`, `guardrail`
  (guardrail or refusal), `generation` (anything else). Messages are the framework's short
  description. The helper keeps serving after an error and exits 0 when stdin closes. It has no
  per-request timeout: the provider kills a helper that does not answer in time.
- **`--status`**: one line `{ status, contextSize }`, exit 0; the framework's `.available` is
  `ready`. Unknown arguments exit 2 with usage on stderr. The M5 reports `ready` with a context of
  **8,192** tokens on macOS 27 (the SDK documents 4,096 before macOS 27); the probe still decides the
  roles.
- **Usage**: the framework's token counts on macOS 27+ (`Response.usage`); otherwise, or when they
  are 0, an estimate of 4 UTF-16 units per token (`estimated: true`).
- **Schema subset**: `object` (property order kept, not in `required` or nullable → optional),
  `array` (`minItems`/`maxItems`), `string` (`enum`/`const` strings → choices), `integer`
  (`minimum`/`maximum`; `exclusiveMinimum`/`exclusiveMaximum` moved inward by 1; zod's ±(2^53−1)
  bounds dropped), `number` (`minimum`/`maximum`), `boolean`, `anyOf` (null branches → optional).
  Contradictory bounds (minimum above maximum) and negative item counts are dropped. Schema names
  are unique paths (`Root_seqs_item`), with a `_2`, `_3`, … suffix on a collision. Dropped: `oneOf`,
  `allOf`, `$ref`, `maxLength`, `pattern`, `format`, `additionalProperties`, number exclusive bounds;
  a node with no expressible type becomes a string. The caller still validates with zod.
- **Messages**: `system` becomes the session instructions, earlier turns become transcript
  prompt/response entries, the last user message is the prompt; one fresh session per request.
- **Start on macOS 14/15**: FoundationModels is weak-linked (`-weak_framework` linker flag), checked by
  the local test with `otool -l`.
- **Test tier**: the real-helper build and smoke test is `apple-helper.local.test.ts` (local tier,
  D-16), not `slow` as phase 11 step 12 says: it needs this Mac, not just time.
**Why**: Smallest choices that make the fake and the real helper interchangeable for phase 11's
`apple.ts` and its tests; the 8k context is a measured fact the spec guessed as "about 4k".

## D-23 · 2026-10-11 · phase 03 (early E5) · Style loading: partial children, merge, chain, paths, token names

**Context**: Early package E5 (D-19) builds phase 03 steps 1–2 and the token names of step 3. The styles
spec fixes the file format but leaves open how a child file inherits, how problems surface and how
tokens are spelled.
**Decision** (`packages/engine/src/styles/{schema,registry,tokens}.ts`):
- **Strict files**: `style.json`, `template.json` and `captions/<preset>.json` reject unknown keys (a typo
  is an error, not an extension).
- **Partial children**: a style with `extends` may leave out `tokens` (or parts of it), `pacing`,
  `imagery`, `captions`, `overlays` and `sfx`. Merge: colours by key, fonts by role (whole `Font`),
  texture and motion by field, pacing and imagery by field, sfx by name; `captions` and `overlays` are
  replaced whole and inherited when absent; `guide.md` by `## ` heading (same heading replaced in place,
  new headings appended, a non-empty preamble replaces the parent's). The merged style must pass the
  complete `Style` schema. Own fields (`id`, `name`, `version`, `description`, `status`, `extends`,
  `source`, `trusted`, `templates`, `transitions`) never inherit. `guide.md` is optional.
- **Chain**: depth counts `extends` hops, at most 4 (5 styles). The chain must end in `base`; `base`
  extends nothing. Cycle, missing parent, deeper chain, wrong root and a child of an invalid style fail
  with `STYLE_INVALID` and `details.reason` (`extends-cycle`, `extends-missing`, `extends-depth`,
  `extends-root`, `parent-invalid`).
- **Search order**: the first `stylesDirs` entry holding an id wins; a later copy is rejected with
  `STYLE_DUPLICATE` and listed in `problems()`, so it never replaces an installed style. A missing dir is
  skipped; dot folders and folders without `style.json` are not styles; the folder name must equal `id`.
- **Loading** is synchronous and eager. An invalid style never fails the whole load: `list()` shows valid
  styles only, `problems()` lists rejected folders, `get(id)` throws the style's error
  (`STYLE_NOT_FOUND` when absent). `template('<styleId>/<name>')` finds any valid style's template.
- **Templates**: scenes and transitions both live in `templates/<name>/`; `name` equals the folder and
  `kind` matches the list (`templates` = scene, `transitions` = transition). A cue's `sfx` must exist in
  the declaring style's merged `sfx`. `blendsShots` only on transitions; `minEntranceMs` (positive
  integer) only on scenes. The variables schema is checked with ajv `strictSchema` (unknown keyword or
  format rejected; a fresh Ajv per check, so a `$id` never clashes), its root must be `type: "object"`,
  and it may not name `skipEntrance` anywhere (D-15).
  `TemplateDef.trusted` is the declaring style's trust (S8).
- **Trust source (S8)**: only a style in the first `stylesDirs` entry (built-in) keeps the `trusted` value
  of its own `style.json`. For any other style the file value is ignored; trust comes from the
  registry option `isTrusted(styleId, dir)` (default: untrusted), so a style folder copied into
  `~/.vox/styles` cannot trust itself. Phase 06's `vox style trust` records trust outside the folder
  (store and format are 06's choice, e.g. `~/.vox/config.json` keyed by id plus a content hash) and
  passes it as `isTrusted`.
- **Caption presets**: a preset id `<styleId>/<name>` of the style itself loads `captions/<name>.json`
  and `.html` (name equals the file); a listed preset of another style must be declared in the chain.
  `position` is required, `safeArea` optional (`captionSafeArea()` gives 20 / 12 on 9:16, 0 / 0
  otherwise); `bottomPct` < 100, `rightPct` < 50.
- **Paths and values**: font files, texture, sfx, template, preset, overlay and guide files must exist
  inside the style folder after `realpath` (a symlink out → `reason: 'path'`; real paths are returned;
  a dangling symlink fails, never counts as absent). `style.json`, `template.json`, fixtures and previews
  get the same check. Path strings are relative, `/`-separated, with no `..`, backslash, quote, `<`, `>`,
  `:`, `%`, `?`, `#` or control character. Token values are allow-listed (`[A-Za-z0-9#.,()%/ +_-]`, no
  `//`) and may call only colour and easing functions (`rgb`, `hsl`, `oklch`, `color`, `cubic-bezier`,
  `steps`, `linear`, … and GSAP eases like `back.out(1.7)`), never `url()`, `var()` or `image-set()`;
  font families `[A-Za-z0-9 _-]`. Nothing breaks out of the generated `<style>` block or fetches a file
  or URL at render time. `tokenVars` re-checks its input.
- **Token names**: `--tok-color-<key>`, `--tok-font-<role>` (quoted family) and
  `--tok-font-<role>-weight`, `--tok-texture-grain`, `--tok-texture-paper` (`url("…")` through the
  caller's asset URL mapper), `--tok-motion-easing|entrance|frame-hold|jitter-px`. camelCase keys become
  kebab-case; numbers are unitless; two colour keys with one CSS name fail `STYLE_INVALID` at load. Output is sorted
  inside the group order colour, font, texture, motion, so CSS is byte-stable.
- **New error codes** (appended to `ERROR_CODES` at the shim swap): `STYLE_NOT_FOUND`, `STYLE_INVALID`,
  `STYLE_DUPLICATE`.
- **Left for phase 06**: the "text variables declare `maxLength`" rule is checked by `vox style validate`,
  not by the loader; unknown JSON Schema formats stay a load error (no `ajv-formats`).

**Why**: Smallest choices that make "child overrides parent tokens, pacing, imagery and guide sections"
work for a partial child (`vox style new --extends`), keep projects on a built-in style unchanged when a
user installs a duplicate id, and keep token values from injecting CSS or HTML into builds. Review
(typescript-reviewer, twice) found the self-declared trust, the Ajv `$id` cache and `url()` in values.

## D-24 · 2026-10-11 · phase 04 (early E4) · Shot list and facetrack crop path details

**Context**: Early package E4 (D-19) builds phase 04's `stages/shots.ts` (step 9c core) and the TS
facetrack path builder `stages/facetrack.ts` (step 12c). The spec fixes the rules (shot resets,
hysteresis, stability, trackSpeed, 300 ms pins, cache key) but not the crop coordinates or the numbers
behind "smooth", "follow" and the speeds.
**Decision**:
- **Shots**: `scdet=threshold=10` then `metadata=mode=print:key=lavfi.scd.time:file=-`; the cut time is
  each printed `pts_time` rounded to ms. The proxy is read as is; the original (no proxy) gets
  `scale=-2:360` first in the same graph. Cuts at 0 or at/after `durationMs` are dropped; the list is
  contiguous from 0 to `MediaItem.durationMs`. No minimum shot length. Errors: `TOOL_MISSING`,
  `TOOL_FAILED` (stderr tail in `cause`), `CANCELLED` (codes shared with E2/E3).
- **Crop coordinates**: `x`, `y` = crop centre, normalised to the source frame (0..1, origin top-left);
  `scale` = zoom relative to the cover crop of the sequence aspect (1 = largest crop of that aspect that
  fits the source). The tracked path pans at scale 1 and keeps the crop inside the source. User pins
  are clamped to scale 1..8 and to a centre that keeps the crop inside the source.
- **Subject per shot**: a class (face, then body and saliency in `auto`) counts when present in at
  least 25 % of the shot's samples (at least one), so a stray detection does not take a shot. The
  target is the box centre. A face or body is followed by nearest centre within the box's size; a
  subject unmatched for 1 s is replaced by the largest box (a pinned face by its index). Hysteresis
  compares box areas (> 1.3×) over a continuous 1 s while the subject is matched; losing the subject
  restarts the count. Each shot reports `subject`, effective `stability`, `switchesAtMs` and
  `faceIndexMissing`, so a fallback is never silent.
- **`faceIndex`**: index in left-to-right order of the faces in the shot's first sample with faces; a
  shot with fewer faces uses the largest (`faceIndexMissing: true`). A pinned face never switches by
  hysteresis. `faceIndex` is added to the cache key, because it changes the path.
- **Stability**: `locked` = the subject centre stays within ±10 % of the crop size of the mid-range
  centre over the whole shot → one static crop at that centre; otherwise the shot is `smooth`.
  `smooth` and `follow` are an exponential follow with time constant 0.4 s and 0.1 s. **trackSpeed**
  caps crop speed at 0.5 / 1 / 2 crop sizes per second (slow / normal / fast).
- **Path shape**: source-time keyframes, linear between keyframes; each shot has a keyframe at its
  start (on the new subject) and a hold at `endMs - 1`; values rounded to 4 decimals; repeated values
  pruned. Repeated sample times keep the last sample.
- **Pins**: a user keyframe holds the crop at its time and blends linearly to and from the tracked path
  over 300 ms on both sides (the spec names only the blend back; a one-sided pin would jump at the pin).
  Two pins up to 600 ms apart join directly. A blend never crosses a shot boundary. Pin times are
  item-relative (`source = inMs + atMs`), so a start trim that shifts `atMs` keeps the pin on its frame.
- **Cache key**: SHA-256 over (path version 1, media hash, aspect reduced by gcd, mode, stability
  default `smooth`, trackSpeed default `normal`, `faceIndex`, optional `inputsHash` of the shots and
  detections files).

**Why**: Smallest choices that make the D-15 fixture tests pass on synthetic and real detections
(`cuts-2shot`, `podcast-2face`); coordinates relative to the cover crop let compile emit translate +
scale directly.

## D-25 · 2026-10-11 · early e3-media-export (phases 04, 05) · Accepted file types, proxy size, ingest and export temp files

**Context**: Early package E3 (D-19) built ingest sniffing/analysis helpers and export targets. The
spec leaves a few choices open: which image and audio types count as media, what "540p" means for a
vertical video, how a silent track's loudness is stored, which audio a CFR copy keeps, and what
happens to a temp file when the engine process itself is killed.
**Decision** (simplest option each; specs unchanged):
- **Accepted types, from content only**: video MP4/MOV/M4V (ISO BMFF, not HEIF/AVIF brands) and
  WebM/MKV; audio WAV, MP3, AAC (ADTS), M4A, OGG, FLAC; images PNG and JPEG only (GIF, WebP, HEIC, AVI
  and anything else → `MEDIA_UNSUPPORTED` with a hint to convert); documents: PDF from content, plain
  UTF-8 text only under `.txt`/`.md`/`.fountain`. A head that decodes as UTF-8 text is never media,
  whatever signature it carries (`<!--ftypisom--><html>` stays markup). SVG, HTML, XML (DASH/SMIL), HLS,
  PLS and concat lists are never accepted; markup is judged only when the text opens with `<`, so a
  note that mentions `<script>` in its body is still a document.
- **ffmpeg inputs** get `-f <demuxer>` (forced, no probing) in addition to the spec's
  `-format_whitelist` and `-protocol_whitelist file,pipe`; MOV/MP4 also pin `-enable_drefs 0
  -use_absolute_path 0` (ffmpeg's defaults, pinned). Images use `png_pipe`/`jpeg_pipe` (`image2` is not
  whitelisted; it would win the probe for a `.jpg` name). Stream selectors are `V` (not `v`), so a
  cover picture (attached_pic) is never taken for the video.
- **Limits**: ffprobe runs time out after 120 s, loudness after max(120 s, duration / 4); pictures
  over 8192 × 8192 and videos with no readable frame rate are `MEDIA_UNSUPPORTED`.
- **Proxy "540p"** means the shorter side is 540 px (never upscaled), so a 1080×1920 reel gets a
  540×960 proxy, matching how `-S res:1080` treats vertical video. Preset `veryfast` (preview only).
- **CFR copy audio**: copied when MP4 can hold it (aac, mp3, alac, ac3, eac3, opus, flac), otherwise
  AAC 256k (e.g. PCM from a MOV, Vorbis from a WebM). Spec says "audio copied"; this is the fallback.
- **Silence**: `ebur128` true peak `-inf` is stored as `-144` dB so `MediaItem.loudness` stays a finite
  number (integrated loudness already floors at −70 LUFS).
- **NTSC fallback**: with the integer-rate set (GATE 1 item 9 failed), a CFR NTSC source also gets a CFR
  copy at the nearest integer rate (`cfr.reason: 'integer-rate'`); other non-fixed rates are stored as is.
- **ffmpeg outputs use `-y` into a temp the engine has just created** (O_EXCL | O_NOFOLLOW) and then
  moved into place; not `-n`, because ffmpeg 8 exits 0 when `-n` refuses an existing file.
- **Temp files**: one no-replace move (`fs/no-replace.ts`: `link` + `unlink`; without hard links an
  O_EXCL placeholder + `rename`). Export temps are `.vox-tmp-<host6>-<pid>-<rand>.<ext>` in the target
  folder (short, so a long final name never passes NAME_MAX; stems capped at 150 UTF-8 bytes); before
  the move the temp must still be the file created (same dev/ino, one link), else `EXPORT_PATH`. A
  temp left by a killed engine is removed by the next export into that folder only when it carries
  this host's tag and its pid answers ESRCH. Ingest copies write `.vox-part-<pid>-<rand>-<name>` beside
  the destination; phase 04 sweeps those in `media/`. Without a target the `renders/` name gets `-2`,
  `-3` … (folder targets get ` (2)`, ` (3)` …), so no mode ever replaces a file.
**Consequences**: Phase 04 wires these into ingest and must sniff and analyse the engine's own copy
in `media/` (not the user's path: no TOCTOU); phase 05 into render/exportCaptions/exportTimeline.
Adding an image or audio type later means one sniff signature plus its demuxer whitelist and a test.

## D-26 · 2026-10-11 · phase 11 (early G1, D-19) · Agent utility details: Keychain keys, usage shape, upper bound, local error type

**Context**: Early package G1 builds phase 11's pure utilities (`loop/envelope.ts`, `loop/repair.ts`,
`config/mask.ts`, `config/keychain.ts`, `providers/prices.ts`). The specs leave these open.
**Decision**:
- **Keychain keys are printable ASCII only** (0x20–0x7e). `security find-generic-password -w` prints a
  non-ASCII password as hex, which cannot be told from a real hex key, so a non-ASCII key is refused at
  `set` (`CONFIG_INVALID`). Control characters are refused anyway: a newline would start a second
  `security -i` command. Arguments to `security -i` are double-quoted with `\` and `"` escaped
  (checked against the real Keychain). `set` failures keep no stderr in `cause`.
- **No `-T`/`-A` access flags** on writes: the creating binary (`/usr/bin/security`) is trusted by
  default and reads go through the same binary, so no prompt appeared on the M5. Phase 11 revisits this
  only if the app or CLI hit a prompt (phase 11 "Risks": `security` prompts).
- **`keychain:` refs are bound to their provider**: `resolveApiKey(ref, deps, providerId)` refuses a
  ref naming another provider. `env:NAME` accepts any upper-case name (a shared config could point an
  attacker's `baseUrl` at `env:AWS_SECRET_ACCESS_KEY`); phase 11 decides whether to allow-list names or
  warn when a config is imported or shared. Plain `http:` to a non-loopback host is not rejected.
- **`baseUrl` rule** (S17): http(s) only; no userinfo, no fragment, no key-like query parameter (names
  compared without case and separators: `api_key`, `apiKey`, `accessToken`; `&` and `;` separators),
  no key-like or opaque 24+ character path segment, no segment after a key-named one (`/key/<v>`).
- **Masking**: `sk-`, `sk-or-`, `sk-ant-`, `sk-proj-` prefixes are shown, other keys show only the last
  four, keys under 24 characters show nothing (`…`).
- **Usage shape for cost math**: `inputTokens` is the total input including cache reads and writes,
  `outputTokens` the total including reasoning (AI SDK convention). Providers that report them
  separately (Anthropic) are normalised by the provider adapter. Reasoning bills at `reasoningPerMTok`
  else the output price; cache reads/writes at their price else the input price.
- **Upper bound** (S23) uses the dearest rate that could apply (max of input, cache read, cache write;
  max of output, reasoning), so it never under-counts. A reported cost of 0 with real usage on a
  priced model is not trusted (BYOK accounting); usage × price is used.
- **Local providers**: `ollama`, `apple` and the `lmstudio` preset cost 0 with no table entry; `9router`
  and other gateways are not local.
- **Text tool-call detection** returns `{kind, tool}`; it matches only known tool names (plus bare
  markers such as `<tool_call>`), scans at most 200,000 characters, and is linear. The loop owns the
  "one correction per step" counter. The repair also accepts a leading prose/code fence and tries up to
  5 `{` starts.
- **Local error type**: `packages/agent/src/errors.pending.ts` (`UtilError`, same constructor shape as
  `VoxError`) until phase 11 swaps in `VoxError`. Codes to append to `ERROR_CODES`: `CONFIG_INVALID`,
  `KEYCHAIN_FAILED`, `PRICE_MISSING`.
**Why**: Smallest options that keep S17, S21, S23 and S30 testable now without importing `@vox/engine`.

## D-27 · 2026-10-11 · early package p2-audioqa · qa.png is drawn with numpy, not ffmpeg `drawtext`

**Decision**: The engine spec drew `qa.png` with ffmpeg `showwavespic` + `drawbox`/`drawtext`. Homebrew ffmpeg 8.1.2 has no `drawtext` (D-17), so `py/vox_py/audioqa.py` draws the picture itself with numpy and writes the PNG with `zlib` (no Pillow, no new pin beyond numpy). The simplest way to label a cue without a font: a vertical marker plus the cue number in a built-in 3x5 pixel font (the same for the kit sheet colours). `qa.json` holds the legend: `png.markers[{cue, x, hero}]` maps each number to its cue, `png.markerScanY` is a pixel row where only markers cross, and `cues[]` has the details. Details fixed with it:
- **Picture**: 1600 px wide ("canvas size" in 05 step 8d means this fixed size, recorded in `png.width`/`png.height`), a 40 px header with numbered markers (red; hero cues magenta), then one 120 px waveform row each for the SFX stem, the speech stem and the mix; green ticks mark the detected SFX onsets. `--kit` writes `kit-<styleId>.png` (strip green/red by verdict, waveform, spectrogram per file, 1200 px wide) and `kit-<styleId>.json`.
- **Request** (03's `cues.json` does not exist yet, so a plain request): `{ mix, stems: { sfx, speech? }, cues: [{ atMs, type, hero }], fps, target, outDir }`; `target` is the loudness target in LUFS (the engine maps the `--loudness` preset to it, D-15), `fps` 23 to 61. Kit: `{ mode: "kit", styleId, files: [{ path, type }], outDir }`. The result is the `qa.json` content plus `outDir`. Inputs over 600 s are `INPUT_TOO_LONG`; kit files are decoded only up to 4 s (a longer file fails `length`).
- **Measurements**: loudness is BS.1770-4 (K-weighting as a 16384-tap FIR of the two biquads, 400 ms blocks, 75 % overlap, -70 LUFS and -10 LU gates), within 0.03 LU of ffmpeg `ebur128` on the fixtures (a test checks 0.1); true peak is the largest sample after ffmpeg resamples to 192 kHz (4x), within 0.4 dB of `ebur128`; clipped = a run of at least 3 samples at or above 0.9997 full scale. An SFX onset is a 1 ms peak-envelope frame above -50 dBFS that follows 50 ms of silence or is 12 dB above the loudest frame of the preceding 10 ms, and the detector re-arms after the envelope falls 15 dB under that hit's peak; a tail is not a hit, a hit on a tail is. Each cue takes the best order-preserving onset within 250 ms (fewest unmatched cues, then least summed delta); `cueTiming` needs the onset within 1 frame (1000/fps ms); `oneEventPerCue` fails on any onset no cue owns (a second event inside a cue's sample, or a stray hit); `spacing` is onset-to-onset under 120 ms; `sfxUnderSpeech` compares K-weighted mean squares of the SFX and speech stems in the 200 ms after each onset, only where at least half of the 20 ms speech frames are above -50 dBFS, and fails under 6 LU; a missing speech stem marks that check `skipped`.
- **Kit checks** (styles spec "SFX rules"): not synthesised = no spectral peak (+-30 Hz) above 90 % of the energy; one event = exactly one onset (a `move` swell counts as one onset, same rule for every type); not a noise bed = fewer than 90 % of active 2048-sample frames with periodogram flatness at or above 0.35 (white noise measures 0.56, a real recording under 0.01); clean edges = first and last 5 ms at or below -40 dBFS peak; peak at or below -1 dBFS; length at most 3000 ms. Limitation: a band-limited noise bed has low flatness and passes that rule; the owner's ear check (GATE 3) covers it.
- **Thresholds file**: `py/vox_py/audioqa_thresholds.json` keeps pass/fail limits under `checks` (never loosened, R3) and measurement settings under `analysis`; it stores the ±1 LU tolerance and no target (D-15).
- Spec edits made with this entry: engine "Audio QA" (`qa.png` sentence, request and kit sheet), phase 05 deliverables line, R5 numpy row.

**Why**: One option that works with the ffmpeg on the M5 and stays in numpy, which the tool already needs. Pillow or a bundled font would add a pin for a picture that only needs lines and digits. A vision model reads the numbers next to the markers and takes the legend from `qa.json`.

## D-28 · 2026-10-11 · phase 02 · Engine contract details fixed at the freeze

**Decision**: Details the engine spec and D-18 left open or that review changed, fixed before the
phase 02 contracts freeze (R2 rows "02"):
- **`OpResult.error` is `VoxErrorJson`** (`{ code, message, hint, details? }`), not a `VoxError`
  instance, so an `ApplyResult` crosses IPC and `--json` unchanged. Thrown errors stay `VoxError`.
  `isVoxError` also accepts a VoxError from another copy of the module (name, string `code` and
  `hint`); the `VoxError` constructor is unchanged.
- **History lines are read loosely**: unknown fields from a newer engine are kept, not rejected
  (`project.json` stays strict). A line is invalid when an `op` entry has no `op` or an
  `undo`/`redo` entry has no `targets`. Only the last line can be torn (unterminated or not JSON);
  a complete JSON line that fails the schema is `HISTORY_CORRUPT` wherever it is, never truncated.
- **Recovery of a coalesced entry** (crash between history append and project write): the replaced
  entry's `before` values are applied first, then the entry's `after` values, because a coalesced
  entry drops keys that returned to their start.
- **A write that fails** (thrown error, not a crash) after the history append takes the line out
  again, so a write reported as failed never comes back as a recovered version.
- **Lock**: `project.lock` is created by hard-linking a fully written temp file
  (`.project.lock.<nonce>`; `link` fails with EEXIST like `O_EXCL`), so a killed writer never leaves
  an empty or torn lock. Content `{ pid, host, startedAt, nonce }`. Breakers of a stale lock are
  serialised by `.project.lock.break` (cleared when older than 10 s) and remove the lock only if it
  still holds the stale content. Only `ESRCH` means a dead pid; `EPERM` counts as alive.
- **S36 order**: when the files changed on disk, the schema is checked before the lock is taken, so
  `SCHEMA_TOO_NEW` leaves no lock file and no log line.
- **External changes**: `getProject`, `view` and `history` reload when another process wrote and
  emit `project.changed` with `actor: 'external'`, like `applyOp`; the event is emitted even when the
  op that found the change fails. A listener that throws never fails a write that landed.
- **Snapshots**: names starting with `auto-` are reserved for the engine (`vox snapshot` refuses
  them; `restoreSnapshot` may still restore them). Snapshots are written to a temp file and
  hard-linked into place.
- **Ids**: prefix + 8 base-36 time digits + 4 base-36 digits from a counter that starts at a random
  value each millisecond and counts up within it (D-18 said "4 random"), so ids made in the same
  millisecond still sort by creation.
- **Validation tightened** (no shape change): override `startMs < endMs` when both are set,
  `sourceRange.outMs > inMs`, transcript `speechRegions` `endMs >= startMs`, `meta.createdAt` and
  `meta.updatedAt` are ISO date-times.
- **Engine API**: `@vox/engine` lists its exports by name (no `export *`). A project folder must be
  a real folder (a symlink is `PROJECT_NOT_FOUND`) whose `project.json` id equals the folder name
  (else `VALIDATION`). `engine.log` writes are best effort.
- **CLI**: `vox undo <project> --run <runId>` runs `undoRun`; `vox op` takes `--actor user|agent|cli`
  (`external` is engine-only), `--run-id`, `--base-version`, `--coalesce-key`; `vox snapshot
  <project> --list`; `vox paths --json` prints `tools: { dir }` until phase 04 fills tool paths.
  Text output drops terminal control characters (names come from project files).
- Spec edits made with this entry: engine "History" (history line reading), "Write order, crash
  recovery, locking" (`ApplyResult.error`, lock step 1, step 2 reads, coalesced recovery),
  "Project folder" (`auto-` snapshot names), CLI table (`undo --run`, `op` flags, `snapshot --list`).

**Why**: Review findings (code, TypeScript, type design, security S1/S25/S36/S22) on the phase 02
diff. Each option is the smallest that keeps done-when #6 (no lost or corrupt project under kill)
and S36 testable, and an `ApplyResult` must be plain data for the app's IPC (phase 08).

## D-29 · 2026-10-11 · phase 01 · GATE 1: all nine items pass; whole-sequence render, opaque preview, NTSC go, no pre-render cache

**Decision**: GATE 1 is decided by its numbers (D-10). Measured on the M5 with HyperFrames 0.8.145,
GSAP 3.15.0 and Electron 44.7.0 (Chromium 152), under the bench lock, in the final run
`pnpm -C spike bench:all` (load averages 5.7–11.9 on 10 cores):

- 1 cuts: 0 mismatches over 43 cuts and 2700 frames (VFR clip included) · 2 A/V: max 0.35 ms ·
  3 render: 0.67× real time (60.5 s for 90 s, `--quality draft --strict-all`) · 5 peak RSS 2.07 GB ·
  9 NTSC 30000/1001: 0 mismatches, A/V max 0.4 ms.
- 4 preview, opaque sandbox: min 26.4 fps per 1 s window, max stall 83 ms, seek to a cut max 53 ms
  with 0 wrong frames in 80 seeks, picture and `<audio>` within 1 frame of the clock during play and
  after 8 seek + play cycles (p95 16.3 / 0 ms and 23.8 / 0 ms), 0 network requests. Attempt 1 failed
  (a measuring error, plus stale pictures for about 1 s after 1 in 40 seeks); attempts 2 and 3 and
  the final run passed after the fixes below.
- 6 op → preview: scene-only patch max 31 ms; full reload max 757 ms (both under 1 s).
- 7 mechanisms: per-instance vars (10 instances), scoped tokens, muted video + separate audio, GSAP
  volume tween all work in render and preview.
- Heavy-scene fps margin: 20.8 % (29 fps), the same in three runs.
- 8 fillers (recorded only): "um" and "uh" survive with and without the filler `initial_prompt`.

Outcome (engine spec "Spike"): HyperFrames renders whole sequences (no hybrid export). The preview
keeps `sandbox-origin="opaque"` (no `allow-same-origin` fallback, no app "Preview fallback").
NTSC go: `canvas.fps` keeps 30000/1001. No pre-render cache (margin ≥ 20 %). Pins: R5 rows for
HyperFrames, GSAP, Electron and the HyperFrames Chrome.

The preview build needs these helpers (`spike/templates/vox-preview.js`). Phase 03 compile and
phase 10a preview carry them over:
- `data-media-start` of preview videos 1 ms late (Chromium truncates `currentTime` to whole µs);
- pre-cue of the next clip and paused exact-frame sync (runtime tolerances: 0.5 s first sync, 40 ms);
- inactive videos stay visible at opacity 0 (with `visibility:hidden` a paused video showed an older
  picture for about 1 s after a seek);
- after a reload, seek to the saved playhead only once every template is mounted (`vox-playhead`);
- the scene-only patch path (`vox-patch`) for op → preview.

The margin is close to the 20 % bar. If phase 10a measures under 20 % on the real styles, the
pre-render cache comes back (D-15 rule), as a new DECISIONS entry.

**Why**: The outcome list in the engine spec selects the outcome from the numbers (D-10, D-15).
Evidence: `docs/SPIKE_RESULTS.md`, `docs/evidence/phase-01/`.

## D-30 · 2026-10-11 · phase 03 · Compile, audio mix and layer renderer: implementation choices

**Decision**: Phase 03 settles these points the specs leave open:
- Template registration: templates write `window.__timelines[mount.key] = mount.register(tl);`
  (`vox.mount` returns `key`; `register` returns `tl`), so `hyperframes lint` sees the registration in
  inline preview templates too. `hyperframes lint` scans only `index.html`; render-mode scene files are
  not linted by it.
- `sfxCues` `atMs: 'entrance'` is offset 0 from the item start; transition cues sit at the cut.
- Shot-blending transitions (`blendsShots`): half the transition in whole frames, rounded up
  (`blendHalf`); the incoming clip starts that many frames early (its `inMs` reduced), the outgoing clip
  runs as many frames longer; the transition instance spans [cut − half, + duration]. `NO_HANDLES`
  uses the same whole-frame half. (A half of 250 ms = 7.5 frames put the incoming clip off the grid and
  showed the source one frame late.)
- Range builds: scenes that start before the range are dropped with a warning; a transition cut by
  the range start is dropped.
- Render builds carry no `<audio>`; preview builds carry `<audio>` per clip and SFX cue (SFX capped at
  3 s). `captions.srt` and `audio/cues.json` are written into every build. Sequence overlays default to
  the style's default overlays.
- Fonts: one `@font-face` per token font file and its same-prefix siblings; weight from the `fvar`
  `wght` axis or OS/2 `usWeightClass`; files copied to `fonts/<styleId>/`.
- Captions: the preset gets `{ chunks, position: { yPct }, safeArea, maxCharsPerLine }`; `base/plain`
  line height is 1.35 × 1.2 em so a 1.2x emphasis word's box stays inside the chunk (and the safe area).
- Audio mix: per clip `atrim` → 48 kHz stereo → `afftdn` (light `nr=12:nf=-40`, strong `nr=24:nf=-30`)
  → gain (target − integratedLufs) dB → `volume` → `afade` (clip-relative) → `adelay` in samples; SFX
  delayed to the cue; `amix normalize=0`, pad/trim to the sequence length, `alimiter` at −1 dBFS
  (`level=0`, `latency=1`), then two-pass `loudnorm` (linear) and back to 48 kHz. Output WAV is
  `pcm_f32le`. Stems (speech = captions source tracks, other, SFX) use the same chains with no limiter
  and no loudnorm. A silent mix skips loudnorm.
- Layer renderer: `compile` option `layers` (scene item ids, `<itemId>-tx`, `overlay-<name>`,
  `captions`; render mode only; unknown ids → `VALIDATION`) emits only those layers on a transparent
  background without media clips; `renderLayers` writes `build/<seq>-layers/` and runs
  `hyperframes render --format mov` (ProRes 4444 with alpha).
- New error codes (R2): `MEDIA_MISSING`, `TEMPLATE_VERSION`, `HOOK_UNTRUSTED` (appended; no code
  renamed or removed).

**Why**: Each is the simplest option that keeps phase 03's done-when (rule 6f); the frame-grid and
caption fixes came from the step 12 and 9c tests.
