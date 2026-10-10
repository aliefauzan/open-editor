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
7. A friend on an Apple Silicon Mac can install it from a `.dmg` and reach a working
   editor through a guided first-run setup. The only terminal step is installing
   Homebrew and ffmpeg (plan D-05), which setup shows as commands to copy.
8. Quick clips (plan D-11): paste a URL, get captioned 9:16 clips with no AI key; adding
   a style is optional; every subtitle can be corrected; the plain clips export as MP4
   with burned-in subtitles and SRT.

## Non-goals

- Windows and Linux builds; Intel Macs (mlx-whisper needs Apple Silicon).
- Multiplayer, accounts, cloud hosting, mobile.
- Colour grading and advanced audio mixing (the "Color" / "Audio" tabs in the
  reference). Clip volume, fades and track mute exist; ducking is v1.1.
- Keyframe editing of arbitrary properties (scene animation is the template's job).
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
  `secure` and `stream` (range requests for video seeking), with `corsEnabled: false`.
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
| Projects | `projects.list`, `projects.create`, `projects.open(id)` → project + version, `projects.reveal(id)` |
| Edits | `ops.apply({ projectId, op, args, baseVersion })` → `{ version, changes }` or `STALE`; `history.undo`, `history.redo`, `history.list(since)` |
| Snapshots | `snapshots.list`, `snapshots.create(name)`, restore via `ops.apply('restoreSnapshot')` |
| Media | `media.importFiles()` (native file dialog, files/folders; test builds started with `VOX_E2E=1` also accept `{ paths }` and skip the dialog, release builds reject it), `media.importUrl(url)`, `media.replace` (op) |
| Captions | `captions.get(projectId, seqId)` → chunks with word keys and times, for the caption lane and the Subtitles panel (edits go through `ops.apply('setCaptions')`) |
| Jobs | `jobs.start(kind, args)` (incl. `quickClips` and `render` with `captions: 'burn' \| 'none'`), `jobs.get(id)` (status, progress, result), `jobs.cancel(id)` |
| Preview | `preview.url(projectId, seqId)` → `vox-media://` build URL |
| Geo | `geo.search(q)` |
| Agent | `agent.run({ projectId, message, workflow?, selection, mode? })`, `agent.runs(projectId)`, `agent.stop(runId)`, `agent.decide(runId, decision)`, `agent.undoRun(runId)` |
| Settings | `settings.get()` (keys masked), `settings.save(patch)` (masked/absent key = unchanged; keys go to the Keychain), `settings.probe(roleOrModel)` |
| Styles | `styles.list`, `styles.get(id)`, `styles.accept(id)`, `styles.remove(id)` |
| Exports | `exports.reveal(path)` (path rule applies) |
| Setup | `setup.status()`, `setup.install(component)`, `setup.updateYtDlp()` |
| Events | `on('project.changed' \| 'job.*' \| 'agent.*' \| 'preview.updated' \| 'setup.progress', handler)` |

All event payloads pass the secret redactor (spec 3).

### Live updates and editing flow

1. User drags a clip → the store applies the op locally (optimistic, marked pending)
   and calls `ops.apply` with `baseVersion`.
2. The engine host applies it and emits `project.changed` with change records.
3. Renderer: if the version is the next one and the op is its own, it confirms. On
   `STALE` it **rebases**: it applies the newer changes, re-runs the pending op against
   the new state (with the user's intent, e.g. "move item X to 12,000 ms"), and retries
   once. If the rebased op fails validation, the drag is reverted with a toast.
4. Agent edits arrive the same way, with an "agent" badge.
5. External edits (`actor: 'external'`, e.g. `vox op` in a terminal, seen by the engine
   host's watcher on `project.json`) trigger a full project reload.

### Preview pipeline

- After a change, the engine host compiles **in memory** (no debounce for single ops;
  150 ms coalescing during drags).
- If only scene items changed, it writes the changed scene instance files and emits
  `preview.updated` with `kind: 'patch'`; the renderer tells the player to remount those
  sub-compositions at the current time.
- Structural changes (media clips, tracks, captions, canvas) write the full build and
  emit `kind: 'reload'`; the player reloads and seeks to the saved playhead.
- The patch mechanism and latency come from engine spike step 6. Target: op → visible
  update < 1 s on the 90 s spike fixture. If item 4 fails in both sandbox modes, or item
  6 fails, the app uses the "Preview fallback" below; GATE 1 picks it from the numbers
  (plan D-10). If item 4 fails only in opaque mode, only the sandbox fallback applies.

### Preview fallback

Written now so GATE 1 needs no design work if the spike fails item 4 (frame-accurate
seek) or item 6 (patch latency):

- Video and audio clips play in native `<video>`/`<audio>` elements, a small pool per
  track, loaded from the `vox-media://` proxies and scheduled from the store's timeline
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
| Python 3.12 + `vox_py` deps (mlx-whisper, mediapipe, rembg, opentimelineio; pyobjc Vision only with styles Part C) | `uv sync --frozen --no-editable` from the bundled `py/` project with its lockfile into `<tools>/py-env` (`UV_PROJECT_ENVIRONMENT`), cache in `<tools>/uv-cache`, Python in `<tools>/python` (`UV_PYTHON_INSTALL_DIR`) | ~1.5 GB |
| ffmpeg, ffprobe | Homebrew only (plan D-05). Setup checks `brew --prefix ffmpeg`; if it is missing, setup shows the two commands (install Homebrew, then `brew install ffmpeg`) with copy buttons and a "Check again" button | never downloaded or bundled by the app; installing Homebrew needs the user's admin password |
| yt-dlp + `yt-dlp-ejs`, deno | yt-dlp's official macOS binary and `deno` release; updated with `yt-dlp -U` (yt-dlp verifies its own release checksums) | updates often; Settings has "Update yt-dlp" |
| Chrome for HyperFrames rendering | HyperFrames' own browser install, run with the bundled pinned CLI | ~250 MB |
| Models: Whisper large-v3-turbo, MediaPipe face detector, rembg model | downloaded on first use of the stage, size shown first | ~1.7 GB total |

The bundled HyperFrames CLI and the `vox` CLI run with the app's Electron as Node, so no
system Node is needed. Setup ends by running the engine's `doctor` checks and shows a
green "Ready" or each failure with its fix. The editor opens before setup finishes, with
the stages that need a missing tool disabled and labelled.

## Packaging and sharing

- `pnpm dist` (electron-builder) produces `Vox-Studio-<version>-arm64.dmg` for macOS 14+
  on Apple Silicon. Target size under 300 MB.
- **v1 signing**: ad-hoc signature only (no Apple Developer account). On the friend's Mac
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
  the builder's own Mac). Building the Apple on-device helper needs Xcode command-line
  tools 26 (macOS 26 SDK); without them `pnpm dist` skips the helper with a warning and
  the Apple provider shows as unavailable.
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

The start screen leads with one field: "Paste a video link or drop a file", plus
"How many clips" (default 3) and "Length" (default 30–60 s). "Make clips" creates a
project and runs ingest → transcribe → facetrack → quick clips (engine spec "Quick
clips") with one progress view. When it finishes, the editor opens with one sequence
tab per clip, each already captioned with the plain `base` preset, and a bar above the
preview offering the next steps, all optional:

- **Fix subtitles**: opens the Subtitles panel (below).
- **Add style**: pick an installed style. "Captions only" switches the sequence's
  style and caption preset (instant, no AI): one `batch` of `updateSequence { styleId,
  overlays: [] }` and `setCaptions { preset: <style's default preset> }`, so no overlay
  is turned on. "Add style beats" runs the agent's Stylize
  workflow (spec 3; needs a configured model, 4-agent) and can be undone as one run.
- **Export**: MP4 with subtitles burned in plus SRT, for this clip or all clips.

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
    reached ($2.00) — Continue with $X / Stop".
  - Each run shows a collapsible activity log built from run records: "Analyzed",
    "Edited in timeline (7 changes)" with each change clickable (selects the item), job
    progress bars, cost so far, skipped steps, "Undo this run".
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
    overlay toggles.
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
  - Caption lane under the video tracks showing caption chunks; double-click a word to
    edit it; "break here" on a word sets `breakAfter`.
- **Inspector (right, collapsible)**:
  - Media clip (video track): in/out, framing mode (cover/contain/facetrack with face
    picker/manual with a drag handle on the preview), image motion, transition in.
  - Media clip (audio track): in/out, volume, fade in/out.
  - Scene clip: a form generated from the template's variables JSON Schema (text fields
    with `maxLength` counters, media pickers for image slots, place search for `geo`
    slots, nested forms for `template` slots, arrays with add/remove); template switcher
    within compatible templates; transition in.
  - Captions: preset, words per chunk, vertical position, enable/disable.
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
  sequences", native save dialog; subtitles burned in (default when captions are on) or
  not.
- Captions as SRT or VTT, including the user's edits.
- "Editable timeline" as OTIO for DaVinci Resolve (FCPXML is v1.1, or v1 if GATE 2 needed it, plan
  D-10).
- Shows job progress; finished files can be revealed in Finder.

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
  (engine).
- v1.1: local image generation toggle (shows download size and licence before first
  use).

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

## Testing

- **Component tests (vitest + Testing Library)**: store change-record application,
  STALE rebase (success and revert), scene inspector form generation from JSON Schema
  (including `template` and `geo` slots), linked selection, keyboard shortcuts.
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
    session's export save dialog;
  - `media.importFiles({ paths })` is rejected unless the build runs with `VOX_E2E=1`;
  - setup: hash mismatch on a downloaded tool is refused; a missing tool disables only
    its stages.
- **E2E quick clips (no model)**: offline fixture media, Length 4–8 s (the fixture is
  20 s; in CI the test build, `VOX_E2E=1`, seeds the transcript from the checked-in
  `transcripts/talking-head-20s.json` by media hash and skips facetrack; on the M5 it
  also runs once unseeded, tagged `slow`) → "Make clips" → 3 captioned sequence tabs → fix a word and nudge its timing in
  the Subtitles panel → export MP4 + SRT; the SRT and a frame of the MP4 show the fixed
  word.
- **E2E (Playwright for Electron)** against the offline fixture project with a mock
  agent model: import media → drag to timeline (linked pair) → trim/split → add
  transition and text → add scene and edit its text → preview shows the change → agent
  run makes edits that appear live → source-approval pause → undo run → export draft MP4
  and SRT with correct duration.
- **Packaging smoke test**: `pnpm dist` builds the `.dmg`; on a clean macOS user account
  the app installs, passes the Gatekeeper step, runs first-run setup and renders the
  fixture.
- **Performance**: op → preview latency on the 90 s spike fixture logged in CI, warning
  above 1 s; the timeline benchmark from the gate.

## Done when

1. 4-core: the app built from `pnpm dist` installs from the `.dmg` on a second Mac
   account, completes first-run setup, and manual editing of the fixture project works
   end to end, including export to MP4, SRT and OTIO; latency target met. Quick clips
   work with no provider configured: a URL becomes 3 captioned clips, a corrected
   subtitle shows in the preview, and MP4 (burned-in subtitles) + SRT export with the
   correction.
2. 4-agent: pasting a YouTube URL and asking "make 3 vox clips" in the agent panel
   produces 3 sequence tabs, each previewable, editable by hand and exportable.
3. Settings can add an OpenRouter key and an Ollama model, probe them and assign roles;
   the key is in the Keychain and never in project files, logs or the renderer.
4. All main / engine-host security tests pass.
5. Style gallery shows `base` and `vox`; with styles Part C it can create, accept and
   discard a style from a reference video.
6. A friend can follow the README from download to first exported clip.
