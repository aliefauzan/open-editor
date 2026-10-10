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
