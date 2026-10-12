# Vox Studio — Overview

Date: 2026-10-10
Status: Revision 3 (desktop app; second review fixes), approved 2026-10-10 (plan D-10)

## Product

A free, local, open-source alternative to invideo.io's agentic video editor, shipped as a
macOS desktop app (Apple Silicon) that can be shared as a `.dmg` or built from the repo.

- **Input** (plan D-13): a link to a public YouTube, Instagram (reel, post) or TikTok
  video (or any other yt-dlp-supported URL), a video file the user already downloaded
  (choose a file or drag it in), a footage folder, or a screenplay plus footage.
- **Agent**: any LLM through the user's own key (Claude via Anthropic, OpenRouter,
  OpenAI, Gemini, OpenCode Zen, a local 9router gateway, Ollama, LM Studio, any
  OpenAI-compatible endpoint), Apple's on-device model (Apple Intelligence, no key), or
  Claude Code through a skill (v1.1).
- **Flow** (plan D-11): paste a URL → clips are cut automatically and subtitled (the
  simple version, no AI key needed) → optionally add a style (style captions, or full
  style beats by the agent) → export. Subtitles can always be corrected by hand.
- **Output**: short vertical clips (default 3 × 30–60 s, 1080×1920), plain with
  subtitles or edited in a chosen style, editable on a multi-track timeline, exported as
  MP4 (subtitles burned in or not), SRT/VTT captions, or an editable OTIO timeline for
  DaVinci Resolve, saved to a file or folder the user picks (plan D-13).
- **Sound** (plan D-14): sound effects are real recordings (CC0 or recorded by the
  project, never synthesised beeps), placed from the timeline's own events, and checked
  by an automatic audio QA that writes numbers plus a picture the agent can look at, and
  five timecodes for a human ear check.
- **First style**: Vox-style paper collage. More styles can be added, including styles
  drafted automatically from a reference video the user uploads.
- **Cost**: $0 with local models; API costs only if the user picks paid models.

## Reference analysis

Reference reel: instagram.com/reel/DePNgrmToh9 (38 s, 1080×1920, 24 fps; an invideo ad).
Its look, which the `vox` style reproduces:

- Paper texture backgrounds, archival photos cut out with a thick red outline, stamps,
  staggered "pop" entrances, slow push-ins, stop-motion feel.
- Maps with yellow land on blue sea, black label tags, route lines.
- Serif kinetic typography revealed word by word; big serif years; yellow label tags.
- Gold frames, newspaper clippings, halftone portraits with iris zoom.
- 2–3 panels stacked vertically in one frame.
- Speaker footage in between, with 1–3-word uppercase mono captions on black boxes,
  centred mid-frame.

Competitor teardown (plan D-15): a static analysis of CapCut 9.4.1 for macOS (strings
only; the app was never run, nothing was copied) compared its engine and agent with
these specs: [engine teardown](../../research/2026-10-10-capcut-engine-teardown.md),
[agent teardown](../../research/2026-10-10-capcut-agent-teardown.md). The resulting
changes are listed under "Competitor teardown changes" below.

## Sub-projects

| # | Spec | Builds |
|---|---|---|
| 1 | [Engine + project model](2026-10-10-vox-engine-design.md) | `packages/engine` (TS library) + `packages/cli` (`vox`): project.json, edit operations with crash-safe undo, compile to HyperFrames, ffmpeg audio mix, stages, `base` style |
| 2 | [Style system + Vox style](2026-10-10-vox-styles-design.md) | Part A style format, Part B `vox` style (4 templates in v1, 4 in v1.1), Part C style-from-reference (re-skin) |
| 3 | [Agent layer](2026-10-10-vox-agent-design.md) | BYO-model agent: providers, roles, tools, plan mode, clipper + free-form (v1), screenplay + Claude Code skill (v1.1) |
| 4 | [Desktop app](2026-10-10-vox-app-design.md) | Electron app (same stack as the IBM project) in two phases: 4-core (shell, first-run setup, preview, timeline, media bin, inspector, export, `.dmg`) and 4-agent (agent panel, provider settings) |

## Build order

The riskiest unknowns (HyperFrames with many video cuts, preview latency, timeline
library fit) are tested first, and the UI comes before the agent so agent output can be
judged visually.

| Step | Builds | Ends with |
|---|---|---|
| 1 | Engine spike (90 s fixture; render, preview, sync, latency) | pinned HyperFrames version and go/hybrid decision written into the engine spec |
| 2 | Engine + CLI | a CLI that renders a captioned 9:16 clip from a URL; OTIO export |
| 3 | Styles Part A + `vox` v1 (paper-collage, map-route, kinetic-serif, stat) | `vox style validate vox` passes; user approves the side-by-side sheet |
| 4 | App 4-core | manual editing in the desktop app end to end; the `.dmg` passes a clean-install test (plan D-16) |
| 5 | Agent: clipper + free-form, tools and plan mode | "make 3 vox clips from URL" by command |
| 6 | App 4-agent | the same from the agent panel, live on the timeline |
| 7 | v1.1: remaining 4 `vox` templates, screenplay workflow, Claude Code skill, local image generation, FCPXML, clip speed, ducking | — |
| 8 | Styles Part C (re-skin from reference video) | a draft style the user picks in a blind A/B |

Steps 7 and 8 both need only step 6 and may run in either order (plan README §3).

Each step gets its own implementation plan and ends with working software.

**v2 (designed, not scheduled)**: agent "review" approval mode on a forked project;
LLM-authored templates for style extraction.

## Main interfaces between sub-projects

- `project.json` (spec 1): media library + sequences of video and audio tracks with
  media clips, scene clips, links, transitions and captions. The single source of truth.
- Edit operations + `applyOp` returning change records, history with undo cursor and
  per-run undo, `project.changed` events (spec 1): used by the agent's write tools
  (spec 3) and UI actions (spec 4). Every write returns `{ version, changes, results }`,
  with a per-op `status` (`succeeded`, `failed`, `conflicted`) and the touched items' new
  state (plan D-15).
- `engine.view(projectId, sequenceId)` (spec 1): a compact flat view of one sequence
  (items, caption chunk text, `version`). The agent reads this, not the full project
  (spec 3).
- Jobs with progress events (spec 1): long tasks for CLI, agent and UI.
- Style format (spec 2): `style.json`, templates with JSON-Schema variables (the agent's
  tool inputs and the UI inspector's forms), transitions, overlays, caption presets,
  `guide.md` (agent instructions per style). The engine ships the `base` style that all
  others extend.
- Compile (spec 1): one sequence → one HyperFrames composition (in memory or on disk),
  used by the preview player (spec 4) and the renderer. Final audio is mixed by ffmpeg.
- `ImageProvider` (spec 1): API image models registered by spec 3; local mflux in v1.1.
- Secret redactor (spec 1, rules in spec 3): applied by engine errors, agent run
  records, app logs and events sent to the UI.
- Workflow files (spec 3): a prompt plus frontmatter `allowedTools`, `roles` and
  `checkpoints`; the agent loop sends only `allowedTools` to the model, and the Claude
  Code skill (v1.1) reads the same files.

## Technology and licences

| Area | Choice | Licence |
|---|---|---|
| Rendering + preview | HyperFrames CLI, `@hyperframes/player`, exact version pinned (pre-1.0) | Apache-2.0 |
| Download | yt-dlp (+ `yt-dlp-ejs`, deno or node for YouTube) | Unlicense |
| Media processing, audio mix | ffmpeg / ffprobe (from Homebrew, required at first run, plan D-05; not bundled) | LGPL/GPL (used as external binary) |
| Transcription | mlx-whisper, `mlx-community/whisper-large-v3-turbo` (from OpenAI's MIT weights) | MIT |
| Speech gate (plan D-15) | Silero VAD, ONNX model vendored in `py/vox_py/models/` and run through `onnxruntime` (no torch) | MIT; MIT |
| Face tracking | Apple Vision (macOS); MediaPipe Tasks `FaceDetector` as the fallback (D-82) | Apache-2.0 (MediaPipe) |
| Cutouts | Apple Vision subject lift first (D-72); fallback rembg with a pinned permissive model (licence verified in the plan; never `bria-rmbg`, which needs a paid commercial agreement) | MIT + model licence |
| Local image generation (v1.1) | mflux + Z-Image-Turbo (default, not gated); FLUX.1-schnell optional (gated on Hugging Face, needs token) | MIT + Apache-2.0 |
| Timeline export | OpenTimelineIO (`.otio`, native import in Resolve 18.5+); FCPXML via `otio-fcpx-xml-adapter` in v1.1, or in v1 if GATE 2 needs it (plan D-10) | Apache-2.0 |
| Maps | Natural Earth shapes + populated places; `d3-geo` | public domain; ISC |
| Saliency fallback for framing (v1, plan D-15); OCR (style extract) | Apple Vision via `pyobjc-framework-Vision`, now a v1 dependency, not only Part C | MIT |
| Agent | Vercel AI SDK `ai@7` + provider packages; Apple Foundation Models through a bundled Swift helper | Apache-2.0; Apple SDK |
| Vox Studio itself | this repo | MIT (plan D-10) |
| Desktop app | Electron, electron-vite, electron-builder, React 19, Zustand, Tailwind + shadcn/ui, `@xzdarcy/react-timeline-editor` (gated by benchmark) | MIT |
| Python env (first run) | uv, bundled | MIT / Apache-2.0 |
| Images | Wikimedia Commons, Openverse; allowlist CC0, PDM, CC BY, CC BY-SA | per asset |
| Fonts | Google Fonts OFL families, bundled | OFL |

Rejected: Remotion (company licence above 3 people, not OSI), OpenMontage (AGPL, heavy,
leans on paid APIs), OpenCut (mid-rewrite, not taking contributions), opencut-classic
(archived, data model unsuited to agent edits), InVideo (paid).

## Out of scope for all four specs

Multiplayer editing, accounts, cloud hosting, mobile, Windows/Linux/Intel Macs, auto-publishing to social
platforms, TTS voiceover, music generation, speaker diarization, colour grading/LUTs.

Deferred to the backlog, not v1 or v1.1 (plan D-15): a music bed with beat-snapped cuts
(librosa), TransNetV2 shot detection (ffmpeg `scdet` is used instead), RNNoise denoise
(ffmpeg `afftdn` is used instead).

## Security summary

- Untrusted HTML (templates, compiled scenes) loads from a separate `vox-media://`
  origin with no preload, no IPC and a strict CSP, in an opaque-sandboxed player
  (spec 4).
- The renderer is sandboxed with context isolation; IPC checks the sender; renderers
  have no network; keys live in the macOS Keychain (specs 3, 4).
- yt-dlp connects only through a local proxy that refuses private addresses; ffmpeg
  runs with `-format_whitelist` so playlist and concat demuxers cannot open other files
  (spec 1).
- Tools downloaded at first run are pinned and hash-checked (spec 4).
- The agent can ingest only sources the user named, or after approval (spec 3).
- Text inside images (frames, archive images, thumbnails) is untrusted content, like
  transcripts; the vision prompt treats it as content, never as instructions (spec 3;
  plan D-15).
- Files are written outside a project only to a path the user chose: a CLI flag or a
  native save/folder dialog in this session; the renderer and the agent cannot name an
  export path (specs 1, 3, 4; plan D-13).
- Browser cookies for Instagram/TikTok are used only after the user turns on an opt-in
  setting; they are never read otherwise (spec 1; plan D-13).
- Compile hooks run only for trusted styles (spec 2).
- Keys are redacted from every output (spec 3).

## Legal notes

- Clipping other creators' videos may infringe copyright depending on use; the tool
  does not judge this.
- Archive images keep their licence and author; `vox credits` lists required
  attributions. Non-commercial and no-derivatives works are excluded; ShareAlike works
  are flagged.
- Reference videos used for style extraction are analysed, never copied into styles.

## Revision 2 changes (after review of 2026-10-10)

- **Engine**:
  - history rebuilt on id-addressed change records, with an undo/redo cursor and per-run
    undo with conflict detection;
  - history-first write order with fsync, torn-line recovery and a cross-process
    lockfile;
  - frame-grid snapping;
  - split video/audio tracks, linked clips and sync lock;
  - audio mixed by ffmpeg;
  - per-instance scene files carry complex variables and scoped tokens;
  - DOM-order layering;
  - a stronger spike (90 s, 40+ cuts, sync, preview fps, memory, latency) and a pinned
    HyperFrames version with contract tests;
  - ingest hardening, a licence allowlist and a permissive rembg model;
  - new features: transitions, text overlay, audio fades, replace media, copy/paste,
    snapshots, SRT/VTT export;
  - OTIO replaces FCPXML as the primary timeline format;
  - `base` style and `packages/cli`.
- **Styles**:
  - `--tok-*` tokens scoped to the declaring style;
  - template identity and version rules;
  - `build.mjs` hooks for trusted styles only;
  - new kinds of style content: transitions, overlays, `geo` and `template` slots;
  - style `status`;
  - only 4 `vox` templates in v1;
  - Part C is now a re-skin with OCR and a blind A/B done-when.
- **Agent**:
  - AI SDK v7 API (`stopWhen`, `inputSchema`, `MockLanguageModelV4`);
  - tools for every op;
  - plan mode for weak models;
  - context compaction;
  - corrected cost bound;
  - secret redactor;
  - ingest source rule and envelope escaping;
  - `agent.*` events;
  - OpenRouter images via `/api/v1/images`;
  - `embed` role;
  - review mode moved to v2.
- **Web**:
  - second credential-less origin with CSP for untrusted HTML;
  - cookie and CSRF-header auth with Origin and Host checks;
  - realpath file checks;
  - in-memory compile with scene patching;
  - STALE rebase;
  - missing endpoints added;
  - a timeline benchmark gate;
  - 4-core / 4-agent split.
- **Order**: the spike runs first and the UI is built before the agent; v1.1 and v2
  tiers are added.

## Revision 3 changes (desktop app; second review of 2026-10-10)

- **Desktop app**: the localhost web UI (spec 4, formerly `vox-web-design.md`) becomes
  an Electron app ([app spec](2026-10-10-vox-app-design.md)):
  - engine and agent run in a `utilityProcess`; the UI calls a typed preload API;
  - `vox-media://` replaces the second origin; the launch-token/cookie layer is gone;
  - first-run setup installs heavy tools; `.dmg` ships ad-hoc signed with documented
    Gatekeeper steps; Developer ID signing is optional later;
  - API keys move to the macOS Keychain (`keychain:` references), shared with the CLI.
- **Second review fixes**:
  - spike step 4 runs the player cross-origin, opaque-sandboxed, under the real CSP,
    with vendored HyperFrames runtime and GSAP, and checks audio sync;
  - ffmpeg hardening uses `-format_whitelist`; the SSRF guard is a filtering proxy;
  - yt-dlp uses `--js-runtimes node` when deno is absent;
  - `hyperframes lint --json` + `render --strict-all` replace the non-existent
    `lint --strict`;
  - undo entries carry `targets[]`, so redo after "undo this run" is defined; recovery
    does not add history entries; locks from other hosts are never broken;
  - scene data uses `data-vox-vars` resolved per mount (no duplicate ids);
  - the agent's only undo tool undoes its own run's edits; the redactor covers all
    `APICallError` fields; `maxOutputTokens` has per-role defaults;
  - naming aligned: `engine.captions` wraps `deriveCaptions`, clipper `layout` vs loop
    `--mode`, one id per style across directories, full semver in `templateVersion`,
    `vox assets generate` added, clip speed marked as needing its own design;
  - the Resolve OTIO claim is marked secondary-source and gated by engine done-when #5.

## Plan review changes (2026-10-10)

Applied from the review of `plan/` (decisions D-04 to D-08 in `plan/log/DECISIONS.md`):

- GSAP accepted as a licence exception (D-04); ffmpeg comes from Homebrew only, so
  installing it is the one terminal step (D-05); proxies use libx264, `render` copies
  HyperFrames' H.264 stream.
- The engine owns the path rule (subpath export `@vox/engine/paths`), the config module
  for `~/.vox/config.json` and the secret redactor, so no package imports the agent.
- `ingest` gains `{ proxies: false }` for styles Part C; `.pdf` text comes from `pypdf`.
- `removeMedia` never deletes files; CLI `<project>` is an id or a unique name;
  `vox undo`/`vox redo` take `<project>`.
- Hook trust follows the template's declaring style.
- The app lists every bundled resource with a packaging self-test, fixes its Electron
  fuses, and defines pass/fail for the timeline gate prototype.
- The agent's injection guard gets a mock-model test in CI.

## Competitor teardown changes (2026-10-10, plan D-15)

Applied from the static teardown of CapCut 9.4.1
([engine](../../research/2026-10-10-capcut-engine-teardown.md),
[agent](../../research/2026-10-10-capcut-agent-teardown.md); decision D-15 in
`plan/log/DECISIONS.md`). Only ideas were taken, no code, prompts or assets. The
contracts are not frozen yet, so `schemaVersion` stays 2:

- **Engine, time and media**: `canvas.fps` is a rational `{ num, den }` from a fixed set
  (NTSC rates included); variable-frame-rate sources get a constant-rate copy; per-source
  loudness is measured and matched before the mix; `render --loudness
  youtube|tiktok|broadcast`; `MediaClip.denoise` (ffmpeg `afftdn`); a Silero VAD speech
  gate before Whisper; transcript words get a `kind` (word, pause, repeat, filler); a new
  `shots` stage (ffmpeg `scdet`).
- **Engine, framing**: `frame.mode: 'auto'`, `stability`, `trackSpeed` and keyframes;
  facetrack resets at shot cuts, keeps its subject with hysteresis and falls back to
  Apple Vision saliency.
- **Engine, captions**: `CaptionChunk` and `CaptionWord` defined (word times for karaoke
  presets); `maxLines`, `maxCharsPerLine`, `gapFillMs`, `autoEmphasis`; overrides become
  their own history entities.
- **Engine, ops and history**: `removePauses` and `removeWords` with `dryRun` (one undo
  entry each); `coalesceKey` merges slider drags; job results apply as one entry and fail
  with `JOB_CONFLICT` instead of overwriting; write results carry per-op `status`;
  `engine.view` gives a compact sequence view; `SCHEMA_TOO_NEW` and a pre-migration
  snapshot.
- **Quick clips**: cleaner clip boundaries (word lead-in, shot cuts, pauses trimmed),
  more no-AI scoring signals, an optional `prompt` for the scorer, cover-style
  transitions at clip edges.
- **Preview**: a conditional pre-render cache if GATE 1 shows a preview fps margin under
  20 %.
- **Agent**: workflow-scoped `allowedTools` (clipper 12 core tools) plus
  `describe_tool` / `call_tool`, with the tool-list cost checked by the probe; per-run
  short aliases; a fresh `view` and a "Changes since your last step" note every step;
  version-stamped compaction stubs; tool-call JSON repair and a repeated-call guard;
  paired `srcMs`/`seqMs`; model-free frame-health checks; `--confirm-plan`; one sub-run
  per sequence; a question-vs-edit gate; `update_todos`; a "tighten" step in the
  clipper; replay tests; on-image text treated as untrusted.
- **App**: `coalesceKey` on sliders, "Pauses & fillers" in the Subtitles panel, the new
  framing controls, the "Confirm plan first" toggle and an editing-by-agent marker on
  sequence tabs.
- **Deferred**: music bed with beat snap, TransNetV2, RNNoise (see "Out of scope").

## Owner decisions (2026-10-10, plan D-10)

- The five specs are approved; the repo licence is MIT.
- Projects live in `~/Movies/Vox Studio/` by default, shared by the app and the CLI.
- GATE 1 follows its numbers; the preview fallback is written into spec 4 now.
- GATE 2: if Resolve rejects the OTIO, FCPXML is tried, then documented manual steps.
- The plan has no time estimates.
- Providers: Claude (Anthropic), OpenRouter, OpenCode Zen, 9router and Apple's on-device
  model join the existing list; evals run on any configured provider.
- Quick clips (D-11): URL → captioned clips without styling or an AI key; style is an
  optional second step; subtitles are editable; plain clips export as MP4 + SRT.
