# Vox Studio — Sub-project 4: Desktop App (Electron)

Date: 2026-10-10
Status: Revision 3 (desktop app replaces the localhost web UI), approved 2026-10-10 (plan D-10)
Overview: [2026-10-10-vox-studio-overview.md](2026-10-10-vox-studio-overview.md)
Depends on: [engine](2026-10-10-vox-engine-design.md), [styles](2026-10-10-vox-styles-design.md), [agent](2026-10-10-vox-agent-design.md)

## Context

A macOS desktop editor with the same shape as invideo's agentic editor (reference
screenshot: agent chat on the left, preview top-centre, media bin bottom-left,
multi-track timeline bottom, step bar "Upload footage → Describe edit → Review cut →
Export"). It wraps the engine and agent and adds manual editing.

It is an Electron app on the same stack as the user's IBM project (`dumpProject/IBM/app`):
Electron, electron-vite, React 19, Zustand, Tailwind + shadcn/ui, electron-builder. It is
shared as a `.dmg` file and from a public repo that anyone can clone and build.

It is built in two phases (overview build order):

- **4-core** (before the agent): app shell, first-run setup, preview, timeline, media
  bin, inspector, export, `.dmg` packaging. Manual editing works end to end.
- **4-agent** (after the agent): agent panel, provider settings, activity log, undo run.

## Goals

1. Everything the agent does is visible live on the timeline and preview.
2. The user can do every edit by hand too: drag, trim, split, delete, link/unlink,
   transitions, text, scene text and images, captions, audio fades, tracks.
3. Preview plays from the compiled HyperFrames composition (no render), and an edit
   shows in the preview in under 1 s.
4. Settings for providers, keys and model roles (spec 3).
5. Style gallery: browse styles and preview templates; with styles Part C, extract a
   style from a reference video and accept or discard the draft.
6. Untrusted HTML (templates, compiled scenes) can never reach Node, IPC or the network.
7. Anyone on an Apple Silicon Mac can install it from the shared `.dmg` (or build it
   from a GitHub clone) and reach a working
   editor through a guided first-run setup. The only terminal step is installing
   Homebrew and ffmpeg (plan D-05), which setup shows as commands to copy.
8. Quick clips (plan D-11): paste a URL, get captioned 9:16 clips with no AI key; adding
   a style is optional; every subtitle can be corrected; the plain clips export as MP4
   with burned-in subtitles and SRT.

## Non-goals

- Windows and Linux builds; Intel Macs (mlx-whisper needs Apple Silicon).
- Multiplayer, accounts, cloud hosting, mobile.
- Colour grading and advanced audio mixing (the "Color" / "Audio" tabs in the
  reference). Clip volume, fades and track mute exist; ducking is a track toggle in the audio clip inspector (v1.1, plan D-61).
- Keyframe editing of arbitrary properties (scene animation is the template's job).
  Framing keyframes are the one exception: "Pin frame here" in the inspector (plan D-15).
- v1: Developer ID signing, notarization and auto-update (see "Packaging").

## Architecture

```
apps/desktop
  src/main/        Electron main process: windows, menus, protocols, IPC routing,
                   dialogs, setup screen hosting
  src/engine-host/ Electron utilityProcess: openEngine + agent; all jobs, file I/O,
                   network (incl. setup downloads and the update check) and keys
  src/preload/     contextBridge API `window.vox` (typed, generated from one schema)
  src/renderer/    React 19 + Zustand + Tailwind/shadcn: the editor UI
```

- The **engine host** runs in a `utilityProcess` so long jobs never block the main
  process or UI. Main and engine host talk over a `MessagePort`.
- The **renderer** calls `window.vox.<method>(args)`; main validates the call with zod
  and forwards it to the engine host. Events (`project.changed`, `job.*`, `agent.*`,
  `preview.updated`) flow back the same way.
- The `vox` CLI (`packages/cli`) stays available. The app menu offers "Install `vox`
  command", which links `/usr/local/bin/vox` (with an admin prompt) or
  `~/.local/bin/vox` to a script that runs the bundled CLI with the app's Electron as
  Node (`ELECTRON_RUN_AS_NODE=1`). App and CLI share the projects folder
  (`~/Movies/Vox Studio/` by default; engine spec "Project folder") and
  `~/.vox/config.json`;
  the engine's cross-process lock keeps them safe together.

### Window security

- `BrowserWindow` with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `webSecurity: true`.
- The renderer loads from a custom privileged scheme `vox-app://` (bundled files only),
  with CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' vox-media: data: blob:; media-src vox-media: blob:;
  frame-src vox-media:; connect-src 'self'; frame-ancestors 'none'`.
- Navigation and new windows are denied (`will-navigate`, `setWindowOpenHandler`);
  external links open in the default browser only through a main-process allowlist
  (licence pages, provider sites).
- Every IPC handler checks that the sender is the main frame of an app window loaded
  from `vox-app://`. Subframes have no preload, so they cannot call `window.vox`.
- The session blocks all `http(s)` requests from renderers. Everything that touches
  the network (ingest, archive search, thumbnails, LLM calls) runs in the engine host;
  archive thumbnails are fetched there and served through `vox-media://`.
- Permissions requests (camera, microphone, geolocation, notifications) are denied.

### Untrusted HTML (`vox-media://`)

- Compiled builds, scene instance files, template previews, thumbnails and project media
  are served only through the `vox-media://` scheme, registered privileged as `standard`,
  `secure` and `stream` (range requests for video seeking), with `corsEnabled: true` so the
  opaque-origin player can load fonts; only font responses carry `Access-Control-Allow-Origin: *`,
  everything else has no CORS header (D-37).
- URLs look like `vox-media://p/<projectId>/build/…`, `…/files/…`,
  `vox-media://styles/<styleId>/…`. The handler applies the engine path rule, imported
from `@vox/engine/paths` (decode
  once, reject NUL/absolute/`..`, `realpath`, prefix check with trailing separator).
- Compiled HTML is served with CSP `default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:;
  font-src 'self'; connect-src 'none'; frame-ancestors vox-app:`.
  The HyperFrames runtime and GSAP are vendored in the build (engine compile).
- Non-media types are served with `Content-Disposition: attachment` and
  `X-Content-Type-Options: nosniff`.
- The player runs with `sandbox-origin="opaque"` (no `allow-same-origin`). Engine spike
  step 4 measures this exact setup; if opaque mode fails, the fallback adds
  `allow-same-origin`, which is still a different origin from `vox-app://` with no
  preload and no network.

### Engine-host API (`window.vox`)

One zod schema defines every method; main validates arguments and the renderer gets
typed calls.

| Area | Methods |
|---|---|
| Projects | `projects.list`, `projects.create`, `projects.open(id)` → project + version + `offline` (media ids whose file is missing; plan D-45), `projects.reveal(id)` |
| Edits | `ops.apply({ projectId, op, args, baseVersion, coalesceKey? })` → `{ version, changes, results }` or `STALE`; with `dryRun: true` in `args` (`removePauses`, `removeWords`) → the ranges, nothing applied; `history.undo`, `history.redo`, `history.list(since)` |
| Snapshots | `snapshots.list`, `snapshots.create(name)`, restore via `ops.apply('restoreSnapshot')` |
| Media | `media.importFiles()` (native file dialog, files/folders; video files MP4/MOV/M4V/WebM/MKV, audio, images, documents; test builds started with `VOX_E2E=1` also accept `{ paths }` and skip the dialog, release builds reject it), `media.importUrl(url)` (YouTube, Instagram, TikTok or any yt-dlp URL; `media.classifyUrl(url)` → `youtube \| instagram \| tiktok \| other \| invalid` for the badge), `media.replace` (op), `media.search(projectId, q)` → media ids matching names, tags, descriptions or transcript text (plan D-45), `media.peaks(projectId, mediaId)` → the waveform peaks of `peaks/<mediaId>.json` or `null` (the renderer CSP allows no fetch; plan D-42) |
| Captions | `captions.get(projectId, seqId)` → `CaptionChunk[]` (lines of words with keys, times and `emphasis`), for the caption lane and the Subtitles panel (edits go through `ops.apply('setCaptions')`) |
| Jobs | `jobs.start(kind, args)` (incl. `quickClips`, `audioQa`, and `render`/`exportCaptions`/`exportTimeline` with `captions: 'burn' \| 'none'` and an optional `targetId`; `render` and `audioQa` take `loudness: 'youtube' \| 'tiktok' \| 'broadcast'`; a raw path in `args` is rejected), `jobs.get(id)` (status, progress, result), `jobs.cancel(id)` |
| Preview | `preview.url(projectId, seqId)` → `vox-media://` build URL |
| Geo | `geo.search(q)` |
| Agent | `agent.run({ projectId, message, workflow?, selection, mode?, confirmPlan? })`, `agent.runs(projectId)`, `agent.stop(runId)`, `agent.decide(runId, decision)` (for a `pauses` pause: `agent.decide(runId, { approve: true, wordKeys: string[] })`, all keys = whole list, empty = skip), `agent.undoRun(runId)` |
| Settings | `settings.get()` (keys masked), `settings.save(patch)` (masked/absent key = unchanged; keys go to the Keychain), `settings.probe(roleOrModel)` |
| Styles | `styles.list`, `styles.get(id)`, `styles.accept(id)`, `styles.remove(id)`, `styles.extract({ name, url? })` (Part C: a link, else main shows the file dialog; returns `{ jobId }` or null on cancel) |
| Exports | `exports.chooseTarget({ projectId?, mode: 'file' \| 'folder', suggestedName?, format })` opens the native save dialog (file) or folder picker (folder, with "New Folder") in main and returns `{ targetId, displayPath }` or `null` on cancel; main keeps `targetId → path` for this session only and maps a job's `targetId` to the engine's `target` (plan D-13, D-45). `exports.lastFolder(projectId)` → `{ targetId, displayPath }` of the folder last used for this project (else `~/Movies`), shown and used as the default (plan D-45). `exports.reveal(path)` (accepts the project's `renders/` or a path the engine host recorded from this session's dialog) |
| Setup | `setup.status()`, `setup.install(component)`, `setup.updateYtDlp()` |
| Events | `on('project.changed' \| 'job.*' \| 'agent.*' \| 'preview.updated' \| 'setup.progress' \| 'host.restarted' \| 'menu.command', handler)`; `preview.updated` is `{ projectId, sequenceId, version, kind: 'patch', patches: [{ id, start, duration, html }] }` or `{ …, kind: 'reload', url }`; `menu.command` is `{ command }` from the native menu bar (plan D-42) |

All event payloads pass the secret redactor (spec 3).

### Live updates and editing flow

1. User drags a clip → on drop, the store applies the op locally (optimistic, marked
   pending) and calls `ops.apply` with `baseVersion`. A drag sends one op on drop, never
   one per mouse move.
2. The engine host applies it and emits `project.changed` with change records.
3. Renderer: if the version is the next one and the op is its own, it confirms. On
   `STALE` it **rebases**: it applies the newer changes, re-runs the pending op against
   the new state (with the user's intent, e.g. "move item X to 12,000 ms"), and retries
   once. If the rebased op fails validation, the drag is reverted with a toast.
4. Agent edits arrive the same way, with an "agent" badge. The user may keep editing a
   sequence the agent is editing; the agent sees those edits in its next step's change
   note.
5. External edits (`actor: 'external'`, e.g. `vox op` in a terminal, seen by the engine
   host's watcher on `project.json`) trigger a full project reload.

Sliders and text fields (volume, framing values, caption text, …) send an op on every
change with a `coalesceKey` of `<field>:<itemId>` (plan D-15). The engine merges entries
with the same key, actor and run that come within 1 s of each other, so one slider drag
or one typed word is one undo entry, and the 500-entry undo window does not fill up.

### Preview pipeline

- After a change, the engine host compiles **in memory** (no debounce for single ops;
  150 ms coalescing while a slider moves or text is typed).
- If only scene items changed, it writes the changed scene instance files and emits
  `preview.updated` with `kind: 'patch'`; the renderer tells the player to remount those
  sub-compositions at the current time. One scene per patch: a change to several scenes at once, or one that changes anything outside the scene instances (SFX `<audio>`, the sequence duration), reloads (plan D-42).
- Structural changes (media clips, tracks, captions, canvas) write the full build and
  emit `kind: 'reload'`; the player reloads and seeks to the saved playhead.
- The patch mechanism and latency come from engine spike step 6. Target: op → visible
  update < 1 s on the 90 s spike fixture. If item 4 fails in both sandbox modes, or item
  6 fails, the app uses the "Preview fallback" below; GATE 1 picks it from the numbers
  (plan D-10). If item 4 fails only in opaque mode, only the sandbox fallback applies.
- **VFR sources** (plan D-15): a video with `vfr: true` plays from its constant-frame-rate
  copy (engine `MediaItem.cfrPath`, `media/<id>.cfr.mp4`). The player never loads a
  VFR file, because `<video>` seeks on VFR land on a neighbouring frame.
- **Pre-render cache** (conditional; GATE 1 decides): if GATE 1 records a preview fps
  margin under 20 % on heavy scenes, the engine host background-renders each scene
  instance with `renderLayers` (engine "Layer renderer") into
  `cache/prerender/<hash>.mp4`, keyed by the instance file hash, and the player mounts
  the cached clip in place of the live sub-composition. Until the clip is ready, the live
  scene plays. An edit changes the hash, so a stale clip is never shown. With a margin
  of 20 % or more there is no cache.

### Preview fallback

Written now so GATE 1 needs no design work if the spike fails item 4 (frame-accurate
seek) or item 6 (patch latency):

- Video and audio clips play in native `<video>`/`<audio>` elements, a small pool per
  track, loaded from the `vox-media://` proxies (the CFR copy for VFR sources) and
  scheduled from the store's timeline
  (in/out, offsets, volume, fades). Media edits then need no compile at all.
- Scenes, overlays and captions compile into a scene-only player build with a
  transparent background, stacked above the media elements and seeked to the renderer's
  clock; when the drift exceeds one frame, the scene player is re-seeked.
- Scene edits keep the patch path (instance files + `kind: 'patch'`); structural scene
  changes reload only the scene player.
- Transitions between media clips preview as cross-fades of the two elements; the exact
  look is visible in "render this frame" and in exports.
- Export is unchanged: the full HyperFrames build renders as before.

## First-run setup

The `.dmg` stays small by shipping only the app; heavy tools are installed on first run
into `~/Library/Application Support/Vox Studio/tools/`, each at a pinned version with a
SHA-256 check (yt-dlp and ffmpeg are the exceptions, below). `VOX_TOOLS_DIR` relocates
this folder (tests always set it to a temp folder; engine spec "Project folder"). A setup screen lists every component
with its size, licence and status, installs them with progress, and can repair one.

| Component | Source | Notes |
|---|---|---|
| uv | bundled in the app (MIT/Apache, ~40 MB) | used to create the Python env |
| Python 3.12 + `vox_py` deps (mlx-whisper, mediapipe, rembg, opentimelineio, `pyobjc-framework-Vision` for facetrack saliency and Part C OCR, `onnxruntime` for the Silero VAD speech gate, whose ONNX model is vendored in `py/`; plan D-15) | `uv sync --frozen --no-editable` from the bundled `py/` project with its lockfile into `<tools>/py-env` (`UV_PROJECT_ENVIRONMENT`), cache in `<tools>/uv-cache`, Python in `<tools>/python` (`UV_PYTHON_INSTALL_DIR`) | ~1.5 GB |
| ffmpeg, ffprobe | Homebrew only (plan D-05). Setup checks `brew --prefix ffmpeg`; if it is missing, setup shows the two commands (install Homebrew, then `brew install ffmpeg`) with copy buttons and a "Check again" button | never downloaded or bundled by the app; installing Homebrew needs the user's admin password |
| yt-dlp + `yt-dlp-ejs`, deno | yt-dlp's official macOS binary and `deno` release; updated with `yt-dlp -U` (yt-dlp verifies its own release checksums) | updates often; Settings has "Update yt-dlp" |
| Chrome for HyperFrames rendering | HyperFrames' own browser install, run with the bundled pinned CLI | ~250 MB |
| Models: Whisper large-v3-turbo, MediaPipe face detector, rembg model (cutout fallback only, D-72) | downloaded on first use of the stage, size shown first | ~1.7 GB total |

The bundled HyperFrames CLI and the `vox` CLI run with the app's Electron as Node, so no
system Node is needed. Setup ends by running the engine's `doctor` checks and shows a
green "Ready" or each failure with its fix. The editor opens before setup finishes, with
the stages that need a missing tool disabled and labelled.

## Packaging and sharing

- `pnpm dist` (electron-builder) produces `Vox-Studio-<version>-arm64.dmg` for macOS 14+
  on Apple Silicon. Target size under 300 MB.
- **v1 signing**: ad-hoc signature only (no Apple Developer account). On a user's Mac
  the first launch is blocked by Gatekeeper. They allow it once: open the app, then
  System Settings → Privacy & Security → "Open Anyway". (From macOS 15 the Finder
  right-click → Open shortcut no longer bypasses this.) The terminal alternative is
  `xattr -dr com.apple.quarantine "/Applications/Vox Studio.app"`. The README and the
  release notes show both, with screenshots.
- **Later (optional)**: Developer ID signing + notarization (Apple Developer Program,
  $99/yr) removes the Gatekeeper step and enables auto-update; electron-builder config
  keeps the hooks ready but off.
- **Updates in v1**: on launch the app checks the GitHub Releases API of the project repo
  for a newer tag and shows a "New version" banner linking to the download. No silent
  updates.
- **Clone path**: the README covers `pnpm install`, `pnpm dev` (runs the app from
  source) and `pnpm dist` (builds the `.dmg` locally, which needs no Gatekeeper step on
  the builder's own Mac). Building the Apple on-device helper needs Xcode or command-line
  tools 26 or newer (macOS 26+ SDK). `pnpm dist` (release build) fails without it; a
  builder without the SDK runs `pnpm dist:no-apple`, which records `appleHelper: false`
  in `build-info.json`, makes `vox self-test` report `notBuilt` (a pass) and hides the
  Apple provider in Settings (plan D-16).
- Keys, projects and tools stay outside the app bundle, so replacing the app with a new
  version keeps everything.
- **Bundled resources** (`extraResources`, real files outside the asar so tools can read
  them): the built-in styles `styles/base` and `styles/vox` with their fonts, textures,
  SFX and previews (the engine host passes `<resources>/styles` as the first
  `stylesDirs` entry, then `~/.vox/styles`); the engine's Natural Earth data and places
  index; the agent's `workflows/*.md` and price table; the pinned HyperFrames CLI,
  player, runtime and GSAP (compile vendors runtime and GSAP from here); `py/` with its
  lockfile; uv; the `vox` CLI; and `bin/vox-apple-llm`, the Swift helper for Apple's
  on-device model (spec 3). A packaging test runs the built app's CLI
  (`vox self-test --json`, Electron as Node) and checks that `styles.list()` returns
  `base` and `vox`, `geo.search('lisbon')` returns a place, the workflow prompts load,
  a fixture compiles with the vendored runtime, a `vox/map-route` scene compiles (its
  vendored hook libraries load without `node_modules`), and `vox-apple-llm --status`
  answers. A second packaging test hashes the app bundle, runs setup and a compile, and
  checks the bundle is unchanged (nothing writes into the app after install).
- **Electron fuses** (set at build time, read back by a test): `RunAsNode` stays on,
  because the `vox` CLI and the bundled HyperFrames CLI run with the app's Electron as
  Node; `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` are
  off; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` are on. Keeping
  `RunAsNode` on lets a local process run Node through the app binary, which it could
  already do with any Node; this is accepted.

## Screens

### Quick clips (start screen)

The start screen leads with one field: "Paste a YouTube, Instagram or TikTok link, or
drop a video file", a "Choose file…" button (native dialog), plus
"How many clips" (default 3) and "Length" (default 30–60 s). "Make clips" creates a
project and runs ingest → shots → transcribe (then highlights on macOS 27, optional, D-75)
and facetrack → quick clips (engine spec
"Quick clips") with one progress view. The clips enter the project as one history
entry, so one undo removes them all. A pasted link shows a badge (YouTube, Instagram,
TikTok, Link) from `media.classifyUrl`; a non-`http(s)` text is refused before any job
starts. `LOGIN_REQUIRED` shows its hint with two buttons: "Choose file…" and "Open
Settings" (the cookies opt-in, plan D-13). When it finishes, the editor opens with one sequence
tab per clip, each already captioned with the plain `base` preset, and a bar above the
preview offering the next steps, all optional:

- **Fix subtitles**: opens the Subtitles panel (below).
- **Add style**: pick an installed style. "Captions only" switches the sequence's
  style and caption preset (instant, no AI): one `batch` of `updateSequence { styleId,
  overlays: [] }` and `setCaptions { preset: <style's default preset> }`, so no overlay
  is turned on. "Add style beats" runs the agent's Stylize
  workflow (spec 3; needs a configured model, 4-agent) and can be undone as one run.
- **Export**: MP4 with subtitles burned in plus SRT, for this clip or all clips, into a
  folder the user picks (export dialog below).

With a `fast` model configured (any provider, including Apple on-device), moment
picking uses the agent's LLM scorer; otherwise the heuristic scorer. The screen also
lists recent projects and "New empty project".

### Main editor (matches the reference layout)

- **Top bar**: project name, step bar (Upload footage · Describe edit · Review cut ·
  Export) that highlights the current stage and jumps to the relevant panel, undo/redo,
  snapshots menu (save / restore), settings, Export button. Native macOS menu bar with
  the same commands and shortcuts.
- **Agent panel (left; 4-agent)**:
  - Chat thread with attachments (media thumbnails, documents), model/mode indicator
    (tools/plan), stop button.
  - Pause cards: "The agent wants to ingest `<source>` — Allow / Deny" and "Budget
    reached ($2.00) — Continue with $X / Stop". An `approval` pause gets one card per
    `kind` in `agent.paused`: `source` → the ingest card, `plan` → the plan card,
    `pauses` → the tighten review list (both below).
  - "Confirm plan first" toggle beside the mode indicator (plan D-15; `agent.run` with
    `confirmPlan`). When it is on, a plan-mode run pauses (`approval`, kind `plan`)
    before any edit and shows a **plan card**: the `ClipPlan` per sequence (each beat
    with its time range, template or speaker, and text), with "Run plan" and "Stop"
    (`agent.decide`). Stop ends the run with nothing from that plan applied.
  - **Tighten review** (clipper): the "tighten" step pauses (`approval`, kind `pauses`)
    and shows its `removePauses` dry-run list as a pause card, in the same form as
    "Pauses & fillers" (tick/untick, seek on click), with "Apply" and "Skip". The pause
    carries `ranges: { wordKey, kind: 'pause' | 'filler' | 'repeat', seqStartMs,
    seqEndMs, text }[]` per sequence. "Apply" sends `agent.decide(runId, { approve: true,
    wordKeys })` with the ticked keys (all keys = whole list); "Skip" sends an empty
    `wordKeys`. The run goes on after the choice.
  - Each run shows a collapsible activity log built from run records: "Analyzed",
    "Edited in timeline (7 changes)" with each change clickable (selects the item), job
    progress bars, cost so far, skipped steps, "Undo this run". In tools mode, the run's
    todo list sits at the top of the log, redrawn on each `agent.todos` event: `done`
    items ticked, the one `in_progress` item highlighted, `pending` items plain.
  - Workflow quick actions: "Make clips from URL" (v1), "Match screenplay" (v1.1),
    "Extract style" (Part C).
  - Input box with drag-and-drop for files; no voice input.
  - In 4-core this panel shows a placeholder with a link to settings.
- **Preview (top centre)**: `<hyperframes-player>` with play/pause, frame step, in/out
  loop, timecode, fit/zoom, safe-area overlay toggle, and a "render this frame" still
  export.
- **Subtitles panel (tab beside the media bin)**: every caption chunk of the sequence
  with its time; click to seek; edit the text in place (edits become word overrides,
  engine spec "Captions"); find and replace across the sequence; nudge a word's start
  or end by frames; split a chunk at a word or merge it with the next; hide a word;
  "Reset to transcript" per chunk or for all. Every edit is one undoable op and shows in
  the preview within the latency target.
  - Mark a word as emphasis, or clear it (override `emphasis`).
  - **Delete word** (text-based cutting): selecting one or more words and pressing
    delete sends `removeWords { sequenceId, wordKeys }`, which cuts their time out of
    the linked video and audio as one undo entry. Hiding a word only hides its caption.
  - **Pauses & fillers**: a "Minimum pause" slider (350 ms and up, default 350 ms; pause
    pseudo-words exist only for gaps of 350 ms or more) and tick boxes for
    fillers and repeats (the `kinds`). "Find" runs `removePauses` with `dryRun: true`
    and lists every range with its time, kind and words; each row can be ticked or
    unticked (all ticked at first), and a click seeks there. "Apply" sends the full list
    as one `removePauses`, or a ticked subset as one `removePauses` with `wordKeys` set
    to the ticked keys (each range still keeps `keepMs`),
    with the dry run's `baseVersion`, so the removal is one undo entry; on `STALE` the
    list is found again. Captions stay right because they are derived.
- **Media bin (bottom left)**: grid/list of media with thumbnails, duration, tags;
  search over names, tags, descriptions and transcript text; filter by kind/origin;
  import (native dialog, drag from Finder, folders) and "import URL"; archive image
  search tab (calls `assets.search`, results from `jobs.get`), with licence and warnings
  shown and fetch/cutout buttons; generated images tab when an image provider exists.
  Right-click a media item → "Replace in timeline with…".
- **Style panel (tab beside the media bin)**: the current sequence's style templates,
  transitions, overlays and caption presets, plus those of `base`, each with its fixture
  preview; items drag onto the timeline (templates as scene clips, transitions onto a
  cut, overlays and caption presets onto the sequence).
- **Timeline (bottom)**:
  - Sequence tabs with "+" (new / duplicate sequence), per-sequence canvas, style and
    overlay toggles. While an agent run edits a sequence, its tab shows an "agent
    editing" marker: the tabs named in the latest `agent.step` `scope` (a sub-run's
    sequence, or all sequences of the run), cleared on `agent.done`. The user may still
    edit them (see "Live updates").
  - Video tracks `V1..Vn` above audio tracks `A1..An`, with lock / hide / mute /
    sync-lock controls; add/remove/reorder tracks.
  - Clips show thumbnails (from sprite sheets) and audio waveforms (from peaks); linked
    clips show a link badge and select together (alt-click selects one); scene clips
    show template name and colour; transitions show as a marker on the cut.
  - Tools: select, blade (split), ripple delete; snapping to playhead, clip edges and
    transcript word boundaries (on the frame grid); zoom with ctrl+wheel or pinch;
    marquee select; multi-select move; copy/paste (`pasteItems`) and duplicate.
  - Drag media from the bin onto a track (video with sound creates a linked pair); drag
    a template or transition from the style panel; "Add text" places
    `base/text-overlay` at the playhead on the top video track.
  - Audio clips have fade handles at their top corners.
  - Caption lane under the video tracks showing caption chunks, with emphasis words
    marked; double-click a word to edit it; "break here" on a word sets `breakAfter`.
- **Inspector (right, collapsible)**:
  - Media clip (video track): in/out (source time), speed (0.25–4×, not on images; plan
    D-62, engine "Clip speed": one `setClipSpeed` with `onOverlap: 'ripple'`), framing mode (cover/contain/auto/facetrack with
    face picker/manual with a drag handle on the preview), image motion, transition in.
    For `auto` and `facetrack`: stability (locked / smooth / follow, default
    smooth) and track speed (slow / normal / fast, default normal). "Pin frame here"
    adds a framing keyframe at the playhead (`frame.keyframes`, `atMs` relative to the
    item start) from the current crop, which the user then drags on the preview; in
    `auto`/`facetrack` it pins the track there, in `manual` it is the crop. Pins are
    listed with their time and a remove button.
  - Media clip (audio track): in/out, speed (0.5–2×), volume, fade in/out, denoise (off / light /
    strong, default off).
  - Scene clip: a form generated from the template's variables JSON Schema (text fields
    with `maxLength` counters, media pickers for image slots, place search for `geo`
    slots, nested forms for `template` slots, arrays with add/remove); template switcher
    within compatible templates; transition in; its sound cues (name, type, time) each
    with a mute toggle (`updateScene { sfxOff }`, plan D-14).
  - Captions: preset, words per chunk, max lines (default 1), max characters per line
    (default 18), gap fill (default 400 ms), auto-emphasis (numbers and capitalised
    words not at the start of a sentence, default off), vertical position, enable/disable. The safe area comes from the
    preset and is not set here.
- **Keyboard**: space play/pause, J/K/L, I/O in/out, B blade, delete, shift+delete
  ripple delete, cmd+C/V/D, cmd+Z/shift+cmd+Z, arrow keys frame step, +/- zoom.

### Timeline implementation

`@xzdarcy/react-timeline-editor` (MIT) covers rows, move, edge trim, grid snap and
custom clip rendering. It does not provide multi-select, marquee, ripple, linked clips,
a caption lane or keyboard handling; these are built in the app (budgeted in the 4-core
plan). It has one maintainer (last push 2026-01).

Gate, run as the first 4-core UI task: a benchmark with 1,000 items on 8 tracks must
drag and trim at ≥ 50 fps on the M5, and a prototype of linked-clip drag plus marquee
must fit the library's event model. "Fit" means: on the benchmark data, dragging one
clip of a linked V1/A1 pair moves both, with equal `startMs` after the drop; a marquee
over 50 items selects exactly those 50; and both work through the library's public
props and events, with no fork or patch of its source. If either fails, the timeline is a custom canvas
component instead (same store and ops, no library).

### Export dialog

- MP4 (quality draft/standard/high, range: whole sequence or in/out), batch "all
  sequences"; subtitles burned in (default when captions are on) or not.
- **Save to** (plan D-13): a row showing where the files go, with "Change…". One file →
  native save dialog with the name prefilled (`<project> - <sequence>.mp4`); several
  files (batch, or MP4 plus SRT) → folder picker with "New Folder". The default is the
  folder last used for this project, else `~/Movies`. The renderer only ever holds the
  `targetId` and the display path. macOS asks before replacing a file; in folder mode
  the engine adds ` (2)` instead of replacing.
- **Loudness target** (plan D-15): YouTube (−14 LUFS, default), TikTok (−12 LUFS) or
  Broadcast (−23 LUFS), sent to `render` as `loudness: 'youtube' | 'tiktok' |
  'broadcast'`.
- **Audio check** (plan D-14): before an MP4 export the dialog runs `audioQa` on the
  sequence with the chosen loudness target (±1 LU) and shows each check as pass/fail
  with its number, the `qa.png` image, and
  the five listen timecodes as buttons that seek the preview there. A failing check
  warns but does not block the export.
- Captions as SRT or VTT, including the user's edits.
- "Editable timeline" as OTIO for DaVinci Resolve, and "Final Cut Pro timeline" as FCPXML 1.8 (v1.1, plan D-64);
  each is its own checkbox and writes its own layer folder.
- Shows job progress; finished files can be revealed in Finder (each written path).

### Settings

- Providers list (add Claude (Anthropic) / OpenRouter / OpenAI / Gemini / OpenCode Zen /
  9router / Ollama / LM Studio / Apple on-device / OpenAI-compatible with base URL;
  presets in spec 3). Apple on-device shows its availability from the helper's
  `--status` ("Ready", "Turn on Apple Intelligence", "This Mac is not eligible", "Model
  downloading", "Needs macOS 26") and needs no key. Key input (write-only, shown masked, stored in the
  Keychain), "Test" button (probe, showing tools/loop/vision/context results), role
  assignment with capability badges, budget limits, and a note per provider that
  project content is sent to it.
- Tools: setup status per component, "Update yt-dlp", repair; Commons contact field
  (engine); "Use browser cookies for Instagram/TikTok" (off by default; Safari, Chrome or
  Firefox; with the note that yt-dlp then sends that browser's login cookies to the
  site; engine `ingest.cookiesFromBrowser`, plan D-13).
- v1.1: local image generation toggle (shows download size and licence before first
  use). Built in phase 14d (D-68) for Z-Image-Turbo: the switch opens a confirmation with the
  download size (about 33 GB, about 10 GB kept) and the licence (Apache-2.0); "Download" runs the
  `imagegen.install` job with progress, switching off asks, then runs `imagegen.remove`. State comes
  in `settings.get` (`imagegen.models`); no new `window.vox` method. FLUX.1-schnell is set up in a
  terminal (`vox doctor` explains the terms and the token). A failed or cancelled install keeps
  its partial download so the next "Download" resumes it (D-69): the row says how much is kept,
  the install confirmation says it resumes, and "Delete partial download" (asks first) runs
  `imagegen.remove`, which also frees it when the model is switched off.

### Style gallery

Grid of installed styles with animated previews and status badges; style detail shows
tokens, templates and transitions (each with fixture previews served via `vox-media://`),
overlays and caption presets; "Set as style for this sequence". With Part C: "New style
from reference video" → pick file/URL → runs the extract job → shows `report.html` in a
sandboxed `vox-media://` frame → Accept or Discard.

## Error handling

- Every failed call shows a toast with the `VoxError` hint; details expandable.
- If the engine host crashes, main restarts it, reloads the open project from disk
  (the engine's recovery handles a half-written op) and shows a banner.
- Job failures show in the job's row with the hint and a Retry button.
- Missing tools show "Set up" buttons that open the setup screen at that component.
- Media missing on disk (moved/deleted) → the clip renders as a red "offline" block and
  the inspector offers relink (`replaceMedia`).
- `UNDO_CONFLICT` on "Undo this run" lists the conflicting items, each clickable.
- `SCHEMA_TOO_NEW` (plan D-15): a project saved by a newer Vox Studio does not open. The
  app shows "This project was made with a newer version of Vox Studio. Update the app to
  open it." The engine never writes to the project, so the newer version can still open
  it unchanged.
- `JOB_CONFLICT` (plan D-15): a job whose result touches items the user changed while it
  ran (e.g. quick clips or facetrack) applies nothing. Its row lists the conflicting
  items, each clickable, and Retry runs the job again on the current state.

## Testing

- **Component tests (vitest + Testing Library)**: store change-record application,
  STALE rebase (success and revert), scene inspector form generation from JSON Schema
  (including `template` and `geo` slots), linked selection, keyboard shortcuts; a drag
  sends one op on drop; slider and text changes carry the same `coalesceKey`.
- **Main / engine-host tests**:
  - IPC: calls from a subframe or a non-`vox-app://` sender are rejected; invalid
    arguments are rejected by zod;
  - `vox-media://`: CSP present on HTML, `connect-src 'none'`, attachment disposition
    for other types, range requests work, path traversal rejected (encoded `..`,
    absolute, NUL, symlink out);
  - a template that tries `fetch('https://example.com')`, `parent.vox` or
    `window.top.location` gets nothing;
  - renderer `http(s)` requests are blocked; navigation and `window.open` are denied;
  - every window has the `webPreferences` flags above (incl.
    `nodeIntegrationInSubFrames: false`); `vox-app://` responses carry the
    app CSP including `frame-ancestors 'none'`; external links open only for
    allowlisted hosts;
  - the packaged app's fuses match "Packaging and sharing";
  - settings: masked keys only reach the renderer; a masked save keeps the Keychain key;
    a model that failed a role's probe cannot be assigned to that role;
  - `projects.reveal` rejects paths outside the projects folder; `exports.reveal` accepts
    only paths under the project's `renders/` or a path the engine host recorded from this
    session's export dialog, and rejects any other path;
  - export targets (plan D-13): `jobs.start('render', …)` with a raw `path`/`file`/`dir`
    in its args is rejected; an unknown or previous-session `targetId` is rejected; a
    `targetId` from `exports.chooseTarget` writes there (test builds with `VOX_E2E=1`
    stub the dialog's answer, release builds cannot);
  - `media.importFiles({ paths })` is rejected unless the build runs with `VOX_E2E=1`;
  - setup: hash mismatch on a downloaded tool is refused; a missing tool disables only
    its stages;
  - opening a project with a higher `schemaVersion` shows the `SCHEMA_TOO_NEW` message
    and leaves `project.json` and `history.jsonl` byte-identical (plan D-15).
- **E2E quick clips (no model)**: offline fixture media, Length 4–8 s (the fixture is
  20 s; in CI the test build, `VOX_E2E=1`, seeds the transcript from the checked-in
  `transcripts/talking-head-20s.json` by media hash and uses the seeded shots and
  facetrack files (`shots/<mediaId>.json`, `facetracks/<mediaId>.json`); on the M5 it
  also runs once unseeded, tagged `slow`) → "Make clips" → 3 captioned sequence tabs → fix a word and nudge its timing in
  the Subtitles panel → export MP4 + SRT; the SRT and a frame of the MP4 show the fixed
  word.
- **E2E (Playwright for Electron)** against the offline fixture project with a mock
  agent model: import media → drag to timeline (linked pair) → trim/split → add
  transition and text → add scene and edit its text → preview shows the change → agent
  run makes edits that appear live → source-approval pause → undo run → export draft MP4
  and SRT with correct duration.
- **E2E editing tools (plan D-15)**, on the offline fixture project:
  - Pauses & fillers: "Find" lists the fixture's known pauses; untick one → "Apply" →
    the sequence is shorter by exactly the ticked ranges, the unticked pause is still
    there, captions stay on their words; one cmd+Z restores the whole removal, and
    `history.list` grew by one entry.
  - Coalesced slider: drag the volume slider through 20 values within 1 s → one new
    history entry; one cmd+Z restores the starting volume.
  - Pin frame: on an `auto` clip, move the playhead, "Pin frame here", drag the
    crop → a keyframe at the playhead (relative `atMs`) and the preview frame there
    shows the pinned crop; moving the clip keeps the pin at the same frame of the
    source; one cmd+Z removes it.
- **Packaging smoke test** (plan D-16; no second account needed): `pnpm dist` builds the
  `.dmg`; an automated clean-install test quarantines it, copies the app to a temp
  folder, records `spctl --assess`, and runs first-run setup with temp `VOX_HOME` and
  `VOX_TOOLS_DIR` and no Homebrew on `PATH`. The setup part is checked when setup is
  built (plan phase 09); the render part is checked with the full editor at GATE 5 (plan
  phase 10b), where the owner also runs the E2E path on their own account with a fresh
  `VOX_HOME`.
- **Performance**: op → preview latency on the 90 s spike fixture logged in the CI slow
  suite (`workflow_dispatch` and weekly, plan D-16), warning above 1 s; the timeline benchmark from the gate.

## Done when

1. 4-core: the app built from `pnpm dist` passes the clean-install test and, on the
   owner's account with a fresh `VOX_HOME`, completes first-run setup, and manual editing of the fixture project works
   end to end, including export to MP4, SRT and OTIO into a folder chosen in the dialog;
   latency target met. Quick clips work with no provider configured: a YouTube,
   Instagram or TikTok link, or a dropped video file, becomes 3 captioned clips, a
   corrected subtitle shows in the preview, and MP4 (burned-in subtitles) + SRT export
   with the correction.
2. 4-agent: pasting a YouTube URL and asking "make 3 vox clips" in the agent panel
   produces 3 sequence tabs, each previewable, editable by hand and exportable.
3. Settings can add an OpenRouter key and an Ollama model, probe them and assign roles;
   the key is in the Keychain and never in project files, logs or the renderer.
4. All main / engine-host security tests pass.
5. Style gallery shows `base` and `vox`; with styles Part C it can create, accept and
   discard a style from a reference video.
6. The README works from download to first exported clip: an automated fresh-clone
   check builds and self-tests the app, and the owner installs the GitHub Release `.dmg`
   following the README and exports a clip (a friend's install is optional; plan D-16).
7. Editing tools (plan D-15): "Pauses & fillers" removes the ticked ranges as one undo
   entry, a slider drag is one undo entry, "Pin frame here" holds the crop at the
   playhead, and an export at each loudness target passes the audio check's loudness
   test against that target.
