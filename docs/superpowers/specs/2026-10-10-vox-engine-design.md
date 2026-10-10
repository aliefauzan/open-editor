# Vox Studio — Sub-project 1: Engine + Project Model

Date: 2026-10-10
Status: Revision 3 (second review fixes; desktop app), approved 2026-10-10 (plan D-10)
Overview: [2026-10-10-vox-studio-overview.md](2026-10-10-vox-studio-overview.md)

## Context

Vox Studio is a free, local, open-source alternative to invideo.io's agentic editor.
See the overview for the product and the four sub-projects. This spec covers
sub-project 1: a headless TypeScript library (`packages/engine`) plus the `vox` CLI
(`packages/cli`). Sub-projects 2–4 (styles, agent, desktop app) consume it; the interfaces
they need are defined here.

### Decisions already made

- All tooling free and permissively licensed (MIT / Apache / BSD), including model
  weights used by default. No Remotion (company licence), no OpenMontage (AGPL), no
  OpenCut fork (mid-rewrite). Accepted exceptions: GSAP (free "Standard License" from
  Webflow, not OSI; vendored into builds with its notices intact; the owner accepted the
  risk of its "Competitive Products" clause, plan D-04) and ffmpeg (GPL/LGPL, used as an
  external binary from Homebrew, never bundled, plan D-05).
- Renderer: HyperFrames (Apache-2.0, HTML + GSAP → video), CLI via `npx hyperframes`,
  preview via the `@hyperframes/player` web component. HyperFrames is pre-1.0 and
  releases often, so the exact version is pinned (`hyperframes` and
  `@hyperframes/player` at the version the spike passes on; 0.8.145 at the time of
  writing) and upgraded only through the contract tests below.
- Transcription: `mlx-whisper` with the pinned repo `mlx-community/whisper-large-v3-turbo`
  (weights converted from OpenAI's MIT release), auto language detection, word
  timestamps.
- Images: Wikimedia Commons + Openverse (no key) with a licence allowlist; `rembg`
  cutouts with a permissively licensed model (never `bria-rmbg`). Local image
  generation is deferred to v1.1 (see "Image generation provider").
- Audio is mixed by ffmpeg from the project model, not by HyperFrames (see "Audio").
- Target machine: Apple M5, 24 GB RAM, macOS. Node 24, pnpm, uv (Python 3.12).
- Default canvas: 1080×1920, 30 fps.
- All times in APIs, files and tool calls are integer milliseconds.

## Goals

1. A single JSON document (`project.json`) fully describes a project: a media library
   and one or more sequences (timelines). It is the only source of truth for agent,
   UI and CLI.
2. Every edit is a typed, validated operation with correct multi-level undo/redo and
   crash-safe history, so an agent can edit safely and the UI can show and undo an
   "edited in timeline" log per agent run.
3. A sequence compiles to one HyperFrames composition. The same compiled HTML is used
   for live preview and final render, so preview matches export. (Exception: if the
   spike fails, export uses the layer renderer; see "Spike".)
4. Ingest, transcription, face tracking, asset fetching and cutouts are cached,
   resumable, idempotent stages.
5. Export to MP4, SRT/VTT captions, and an editable OTIO timeline for DaVinci Resolve.
6. A stable library API with change events and job progress, so the desktop app (4) and
   agent (3) need no knowledge of files on disk.

## Non-goals (this sub-project)

- LLM calls of any kind (sub-project 3).
- Desktop app and its packaging (sub-project 4).
- Real style designs (sub-project 2). This spec defines how styles plug in and ships
  one generic style, `base` (see "Base style").
- Music generation, TTS, speaker diarization, colour grading, multiplayer, cloud.
- v1.1 (built later): local image generation (interface specified here), audio
  ducking (approach noted under "Audio"), FCPXML export, and clip speed (needs its own
  design: a `speed` field, duration rule `inMs + durationMs × speed`, audio `atempo`,
  and a spike on HyperFrames `playbackRate`).

## Repository layout

```
videoeditor/
  package.json, pnpm-workspace.yaml
  packages/
    engine/                  # this sub-project: TS library, no CLI entry
      src/model/             # zod schemas, types, normalise/denormalise
      src/ops/               # edit operations
      src/history/           # change records, undo cursor, recovery, lockfile
      src/compile/           # sequence → HyperFrames project (in memory + to disk)
      src/audio/             # ffmpeg mix graph from the model
      src/stages/            # ingest, transcribe, facetrack, assets, render, export
      src/styles/            # style registry + loader (format defined in spec 2)
      src/jobs.ts            # job runner with progress events
      src/api.ts             # public library API
      src/py.ts              # typed bridge to Python tools
      src/paths.ts           # path rule (also the subpath export `@vox/engine/paths`)
      src/config.ts          # ~/.vox/config.json, the one reader/writer for all packages
      src/redact.ts          # shared secret redactor (rules in spec 3)
      test/
    agent/                   # sub-project 3 (depends on engine)
    cli/                     # `vox` binary; depends on engine and agent
  styles/                    # built-in styles; engine ships styles/base
  apps/
    desktop/                 # sub-project 4 (Electron)
  py/                        # uv project, Python 3.12
    pyproject.toml
    vox_py/transcribe.py     # mlx-whisper
    vox_py/facetrack.py      # MediaPipe Tasks FaceDetector
    vox_py/cutout.py         # rembg
    vox_py/timeline.py       # opentimelineio export
  projects/                  # dev scratch only, gitignored (real projects: "Project folder")
  docs/superpowers/specs/
```

`packages/cli` owns the `vox` command so the engine never imports the agent (no
cycle). Engine commands, `vox style …` and `vox agent`/`vox config` all live there.

Python bridge: each tool is a module run as
`uv run --frozen --project py python -I -m vox_py.<tool>`. It reads one JSON request on stdin,
writes one JSON result on stdout, and writes progress as JSON lines on stderr
(`{"progress": 0.42, "message": "..."}`). `src/py.ts` validates both sides with zod.
In the packaged app, `py/` ships in the app resources and its environment lives in the
app's tools directory (spec 4): setup runs `uv sync --frozen --no-editable` and the
engine runs `uv run --frozen --no-sync`, both with `UV_PROJECT_ENVIRONMENT=<tools>/py-env`,
`UV_CACHE_DIR=<tools>/uv-cache` and `UV_PYTHON_INSTALL_DIR=<tools>/python`, so uv never
writes into the app bundle (no `__pycache__` beside the bundled sources) or rewrites
`uv.lock`. `py/pyproject.toml` declares a build backend that packages `vox_py`, so the
module is importable under `python -I`. `openEngine` takes the tool paths as
options.
Arguments are never passed through a shell.

## Project folder

Projects live in the projects folder, shared by the app and the CLI. The default is
`~/Movies/Vox Studio/` (plan D-10), created on first use with mode `0700`. The first of
these wins: the CLI flag `--projects-dir`, the environment variable `VOX_PROJECTS_DIR`,
`projectsDir` in `~/.vox/config.json`, the default. `vox paths --json` prints the
resolved projects folder, styles folders and tool paths.

Two more overrides exist mainly for tests: `VOX_HOME` (default `~/.vox`) relocates
`config.json` and the user styles folder, and `VOX_TOOLS_DIR` (default
`~/Library/Application Support/Vox Studio/tools/`) relocates the tools directory.

Styles folders, in search order: the built-in styles (the repo's `styles/` in
development, `<resources>/styles` in the packaged app, found relative to the running CLI
or app), then `~/.vox/styles`. Tool paths: the app's tools directory
(`~/Library/Application Support/Vox Studio/tools/`) when it exists, then `PATH`
(Homebrew's prefix for ffmpeg).

```
<projectsDir>/<projectId>/
  project.json
  history.jsonl              # one change record per applied version (see History)
  history/                   # rotated history segments + snapshots
  project.lock               # cross-process write lock (transient)
  media/<mediaId>.<ext>      # originals
  proxies/<mediaId>.mp4      # 540p H.264, all-keyframe-every-0.5 s, for preview
  audio/<mediaId>.m4a        # extracted audio for preview <audio> elements
  thumbs/<mediaId>.jpg       # sprite sheet (1 frame / 2 s) for the UI
  peaks/<mediaId>.json       # audio waveform peaks for the UI
  transcripts/<mediaId>.json
  facetracks/<mediaId>.json
  build/<sequenceId>/        # compiled HyperFrames project (regenerated)
  renders/                   # exports
  snapshots/<name>.json      # named project snapshots
  cache/                     # hash-keyed stage outputs; cache/assets/<queryHash>.json
```

All paths in `project.json` are relative to the project folder. Path rule, used by the
loader, compile, and the desktop app's `vox-media://` protocol handler: decode once; reject NUL bytes,
absolute paths and any `..` segment; resolve with `realpath` (follows symlinks); accept
only if the result starts with `realpath(projectDir) + path.sep`. Ingested folders are
copied, never symlinked.

## Data model (`project.json`)

### Time and the frame grid

Timeline times are integer milliseconds that lie on the sequence's frame grid:
`ms(f) = Math.round(f * 1000 / fps)` for an integer frame `f`, and
`frame(ms) = Math.round(ms * fps / 1000)`, which round-trips exactly for grid values.
Every operation snaps an item's start and end to the grid, then stores
`durationMs = end − start`, so adjacent items never gap or overlap by a frame. Compile
uses `startFrame = frame(startMs)` and `endFrame = frame(startMs + durationMs)`.
Changing a sequence's fps re-snaps all items in that sequence (one history entry).
Source offsets (`inMs`) are snapped to the same grid.

### Schema

Loading rejects unknown fields, so a new field always comes with a `schemaVersion` bump
and a load-time migration.

```ts
Project {
  schemaVersion: 2
  id: string; name: string
  version: number            // increments on every applied history entry
  media: MediaItem[]
  sequences: Sequence[]      // the UI shows them as tabs
  meta: { createdAt: string; updatedAt: string; sourceUrls: string[] }
}

MediaItem {
  id: string
  kind: 'video' | 'audio' | 'image' | 'document'   // document = screenplay, notes
  path: string
  proxyPath?: string; audioPath?: string; thumbsPath?: string; peaksPath?: string
  textPath?: string                                // documents: extracted plain text
  durationMs?: number        // video/audio only
  width?: number; height?: number; hasAudio?: boolean
  origin: { type: 'url' | 'upload' | 'archive' | 'generated'
            url?: string; license?: string; licenseUrl?: string
            author?: string; attribution?: string; prompt?: string }
  transcriptPath?: string; transcriptRev?: string  // rev = hash of transcript file
  facetrackPath?: string
  tags: string[]; description?: string             // filled by the agent
}

Sequence {
  id: string; name: string
  canvas: { width: number; height: number; fps: 24 | 25 | 30 | 60 }
  styleId: string            // default style for captions, overlays, agent hints
  videoTracks: Track[]       // index 0 is the bottom layer
  audioTracks: Track[]
  captions: CaptionTrack | null
  sfx: boolean               // play template sfx cues; default true
  overlays?: string[]        // full overlay ids; absent = the style's default overlays
  sourceRange?: { mediaId: string; inMs: number; outMs: number }  // set by quick clips and the clipper
}

Track {
  id: string                 // unique within the sequence: 'V1'..'Vn', 'A1'..'An'
  name?: string
  locked: boolean; hidden: boolean; muted: boolean
  syncLock: boolean          // default true; ripple/insert shift this track too
  items: Item[]              // stored sorted by startMs; no overlaps within a track
}

Item = MediaClip | SceneClip

ItemBase {
  id: string                 // unique within the project
  startMs: number; durationMs: number
  linkId?: string            // items sharing a linkId move/trim/split/delete together
  transitionIn?: { template: string; durationMs: number }  // see Transitions
}

MediaClip extends ItemBase {
  type: 'media'
  mediaId: string
  inMs: number               // offset into the source; 0 for images
  // video tracks:
  frame?: { mode: 'cover' | 'contain' | 'facetrack' | 'manual'
            x?: number; y?: number; scale?: number; faceIndex?: number }
  motion?: { type: 'none' | 'push-in' | 'pan'; amount: number }   // images only
  // audio tracks:
  volume?: number            // linear gain 0..2, default 1
  fadeInMs?: number; fadeOutMs?: number   // default 0
}

SceneClip extends ItemBase {
  type: 'scene'
  template: string           // '<styleId>/<templateName>', e.g. 'vox/paper-collage'
  templateVersion: string    // the template's full semver when placed; compile compares majors
  variables: Record<string, unknown>   // validated against the template's schema
}

CaptionTrack {
  enabled: boolean
  sourceTrackIds: string[]   // audio tracks whose clips provide the spoken words
  preset: string             // full id '<styleId>/<presetName>'
  maxWords: number           // words per chunk, default 3
  position: { yPct: number } // default from the preset
  overrides: { wordKey: string; text?: string | null; breakAfter?: boolean
               startMs?: number; endMs?: number }[]   // startMs/endMs in source-media time
}
```

Track-kind rules:

- Video tracks accept `SceneClip`s and `MediaClip`s of video or image media. A video
  `MediaClip` on a video track is picture only; it is always emitted muted.
- Audio tracks accept only `MediaClip`s of audio media, or of video media with
  `hasAudio` (sound used, picture ignored).
- Document media is never placed.
- Placing a video with sound (`placeClip` with `withAudio`, default `true` when
  `hasAudio`) creates a picture clip on the target video track and a linked sound clip
  on the target audio track (default `A1`) with the same `linkId`, `startMs`, `inMs`
  and duration.

A sequence may use templates from any installed style; `styleId` only sets defaults
(caption preset, overlays, which templates the agent is offered first).

### Captions

`deriveCaptions(project, sequenceId) → CaptionChunk[]` is a pure function exported from
the model module, used by compile and the SRT/VTT exporter. The library API wraps it as
`engine.captions(projectId, sequenceId)` for the UI caption lane.

- For each `MediaClip` on a source audio track, take transcript words whose midpoint lies
  in `[inMs, inMs + durationMs)`, shift them to timeline time, and clamp them to the clip.
  Zero-length words get one frame. Overlapping words are trimmed to the next word's start.
- Apply overrides. `wordKey` = `<mediaId>:<transcriptRev>:<wordIndex>`, so a
  re-transcription orphans old overrides instead of misapplying them; orphans are
  reported by `vox doctor <project>` and dropped by `setCaptions`.
- Chunk by `maxWords`, by pauses over 300 ms, at clip boundaries and after any word
  with `breakAfter`.
- Where two source tracks overlap in time, the lower track index wins.
- For languages written without spaces (e.g. Japanese, Chinese), Whisper's tokens are
  used as-is and chunking is by character count (`maxWords × 4`).

Trimming or moving a clip keeps captions correct because they are derived.

Editing captions (plan D-11): transcripts are sometimes wrong, so every caption is
editable through `setCaptions` overrides, one undoable entry per edit:

- `text` replaces a word's text. It may contain several words (a word Whisper missed is
  added by editing its neighbour); they share the word's time, split evenly, and count
  as separate words for chunking. `text: null` hides the word.
- `startMs`/`endMs` correct a word's timing (source-media time; the result is shifted
  and snapped to the frame grid like any word).
- `breakAfter` ends a chunk after the word; it is how chunks are split or (by removing
  it) merged.
- The transcript itself is never edited, so "reset" removes the overrides.

### Transitions

`transitionIn` on an item describes the cut between it and the previous item on the
same track. `template` names a transition template (kind `transition`, spec 2), e.g.
`base/crossfade`, `vox/paper-tear`. Compile mounts it on a layer directly above the
track, centred on the cut, for `durationMs`. Templates that blend the two shots (e.g.
crossfade) need source handles: the outgoing and incoming media must extend
`durationMs / 2` beyond the cut. If not, the op fails with `NO_HANDLES` and
the hint suggests a cover-style transition. Items still never overlap in the model.

### Base style

The engine ships `styles/base` (format in spec 2) so it works without any other style:

- templates `title`, `text-overlay` (free text over picture, the "add text" feature),
  `placeholder` (used for gaps the agent could not fill);
- transitions `crossfade`, `dip-to-black`;
- caption preset `base/plain`;
- fonts Inter (display and body) and IBM Plex Mono (captions), both OFL, in
  `styles/base/assets/fonts/` with their licence texts.

Every other style `extends: base`, directly or through a chain.

## Edit operations

`src/ops/` exports pure functions `(project, args) => project`, each with a zod schema
for `args`. Every operation that touches a timeline takes `sequenceId`. The agent's
write tools are generated from this table, so every op is available to the agent.

| Operation | Purpose |
|---|---|
| `addMedia`, `updateMedia`, `removeMedia` | library (remove fails if any clip uses it; it removes the library entry only and never deletes files on disk) |
| `replaceMedia` | point every clip using media A at media B (same kind); clamps out-of-range clips and reports them |
| `addSequence` | creates a sequence with default tracks `V1`, `V2`, `A1`, `A2` and captions off |
| `updateSequence`, `duplicateSequence`, `removeSequence` | update covers name, canvas (re-snaps on fps change), styleId, sfx, overlays |
| `addTrack`, `updateTrack`, `removeTrack`, `reorderTracks` | tracks |
| `placeClip` | put a media clip on a track at a time (`withAudio`, `onOverlap`) |
| `addScene`, `updateScene` | add/edit a scene clip; `updateScene` may switch to a compatible template: every required variable of the target exists in the scene's variables with the same JSON-Schema type, and slot kinds (`media`, `geo`, `template`) match by key; variables the target does not declare are dropped and listed in the result |
| `moveItem` | change track and/or start time (`onOverlap`) |
| `trimItem` | change start/in/duration from either edge |
| `splitItem` | split at a timeline time into two items (linked items split too) |
| `removeItem` | delete an item (and linked items unless `unlinked: true`) |
| `rippleDelete` | delete a range and close the gap on the track and all sync-locked tracks |
| `link`, `unlink` | set or clear `linkId` on items |
| `setTransition` | set or clear `transitionIn` on an item |
| `setCaptions` | enable/configure captions, word overrides |
| `pasteItems` | place copied items (serialised items with new ids) at a time on mapped tracks |
| `restoreSnapshot` | replace sequences and media with a snapshot's (one history entry) |
| `batch` | apply a list of operations atomically (all or nothing, one history entry) |

Rules enforced by every operation (invalid input throws `VoxError` with `code`,
`message`, `hint`):

- No overlapping items on one track. `placeClip`, `addScene`, `moveItem` and
  `pasteItems` take `onOverlap: 'error' | 'overwrite' | 'insert'`, default `'error'`.
  `insert` shifts later items on the target track and every sync-locked track.
- Linked items move, trim, split and delete together unless `unlinked: true` is passed.
- For video and audio media, `inMs + durationMs` never exceeds the media duration.
  Image clips have no source duration limit.
- Locked tracks reject changes, including shifts caused by ripple or insert (the op
  fails with `TRACK_LOCKED` naming the track).
- Scene variables must match the template's schema (recursively for `stack` panels);
  duration must be within the template's bounds.
- Times are snapped to the frame grid before validation.

## History

### Change records

Undo does not use Immer array patches (their index paths break once anything else
edits the array). Instead, the project is viewed as a map of entities addressed by
stable keys:

| Key | Entity |
|---|---|
| `project` | name, meta |
| `media:<mediaId>` | a MediaItem |
| `sequence:<seqId>` | sequence fields + ordered track ids |
| `track:<seqId>/<trackId>` | track fields (no items) |
| `item:<seqId>/<itemId>` | an item plus its `trackId` |
| `captions:<seqId>` | the CaptionTrack |

`normalise(project) → Map<key, entity>` and `denormalise(map) → project` convert both
ways (items re-sorted by `startMs`). After an op runs, the engine diffs the normalised
before/after views and records only changed entities:

```ts
HistoryEntry {
  version: number            // project version after this entry
  ts: string
  kind: 'op' | 'undo' | 'redo'
  actor: 'user' | 'agent' | 'cli' | 'external'
  runId?: string             // agent run that produced it
  op?: string; args?: unknown           // for 'op'
  targets?: number[]         // for 'undo'/'redo': the versions being undone/redone
                             // (one for a normal undo, several for undoRun)
  changes: { key: string; before: Entity | null; after: Entity | null }[]
}
```

`before: null` = created, `after: null` = deleted. The set of keys is the entry's
touched set.

### Undo / redo cursor

- The undo stack is the list of `op` entries (and `redo` entries) not yet undone, in
  order; the redo stack is the list of undone entries since the last new `op`.
- `undo` takes the top of the undo stack, applies its `before` values as a new `undo`
  entry with `targets` set, and pushes that undo entry onto the redo stack.
- `redo` takes the top of the redo stack and re-applies its own inverse: for each key,
  the `after` value of the newest targeted entry that touched it. This works the same
  for a normal undo and for an `undoRun` entry (several targets).
- Any new `op` clears the redo stack.
- The cursor is rebuilt on load by scanning the history (cheap; entries are small).
- Undo depth is 500 entries; older entries stay in the log but are not undoable.

### Undo an agent run

`undoRun(projectId, runId)` collects all un-undone entries with that `runId`, newest
first. For each key they touch, the current value must equal the newest entry's
`after` for that key. Keys that fail this check were changed later by someone else, so
the call returns `UNDO_CONFLICT` with those keys (and the item ids inside them) and
changes nothing. With no conflict, it applies the oldest `before` per key as one
`undo` entry whose `targets` lists the run's versions; it goes on the redo stack like any
undo.

### Write order, crash recovery, locking

`applyOp(projectId, op, { actor, runId?, baseVersion? }) → { version, changes }`:

1. Take the cross-process lock: create `project.lock` with `O_EXCL`, containing
   `{ pid, host, startedAt }`. If it exists, was written by this host, and its pid is
   dead (or it is older than 60 s), remove and retry; otherwise wait up to 5 s, then
   fail `LOCKED`. A lock from another host is never broken automatically (projects on
   shared drives are not supported; `vox doctor <project> --unlock` removes it).
2. If `project.json`'s on-disk version differs from the cached one (another process
   wrote), reload and emit `project.changed` with `actor: 'external'`.
3. If `baseVersion` is given and differs from `project.version`, fail `STALE`.
4. Run the op and compute `changes`.
5. Append the history line and `fsync` the file.
6. Write `project.json` to a temp file, `fsync` it, rename over the old file, `fsync`
   the directory.
7. Release the lock and emit `project.changed { projectId, version, actor, runId, op,
   changes }`.

On load, before anything else:

- A last history line that does not parse (torn write) is truncated.
- If the last entry's `version` is `project.version + 1`, its `after` values are
  applied and `project.json` is rewritten (the crash happened between steps 5 and 6).
  The recovered entry keeps its own version; recovery adds no history line and does not
  bump the version; it only logs a line to `logs/engine.log`.
- Any other gap fails with `HISTORY_CORRUPT` and a hint to restore from `snapshots/`.

`history.jsonl` rotates at 5,000 entries into `history/<firstVersion>.jsonl.gz`;
rotation also writes `history/snapshot-<version>.json`.

The desktop app (spec 4) also watches `project.json` so that a `vox op` from a terminal
shows up in the open editor.

### Snapshots

`snapshot(projectId, name)` copies `project.json` to `snapshots/<name>.json`.
`restoreSnapshot` is an op, so restoring is undoable.

## Compile: sequence → HyperFrames

`compile(projectId, sequenceId, { mode: 'preview' | 'render', range? }) → BuildResult`
builds the composition **in memory** (a map of path → content plus a list of linked
media files). `writeBuild(result)` writes it to `build/<sequenceId>/`. The desktop app
uses the in-memory result to patch the player without a full reload (spec 4).

Output:

- `index.html`: root composition with canvas size, fps and duration = end of the last
  item. The HyperFrames runtime and GSAP are vendored into `build/vendor/` from the
  pinned packages and referenced locally; the player's CDN auto-injection is disabled,
  so the build works under the `vox-media://` CSP (spec 4) and offline. Fonts of every style in use become `@font-face` rules pointing to files copied
  into `build/fonts/`. Each style in use has its `assets/` folder copied (hard-linked) to
  `build/styles/<styleId>/assets/`; templates reference textures, SFX and helper scripts
  such as `motion.js` by that relative path.
- **Paint order comes from DOM order.** HyperFrames ignores `data-track-index` when
  rendering, so compile emits layers in this order, bottom to top: video tracks
  `V1..Vn` (each followed by its transition layer), style overlays (spec 2), captions.
  Hidden tracks are skipped.
- Each video-track `MediaClip` becomes a timed, always-muted `<video>` or `<img>`
  (`data-start`, `data-duration`, `data-media-start`). `preview` uses proxies; `render`
  uses originals. `facetrack` framing becomes GSAP keyframes on `object-position`; image
  `motion` becomes a GSAP transform.
- Each `SceneClip` becomes a sub-composition mount pointing at a **per-instance file**
  `build/<seq>/scenes/<itemId>.html`. Compile writes it from the template's HTML and
  injects:
  - `<script type="application/json" data-vox-vars>` with the resolved variables
    (media ids replaced by build-relative file paths; `stack` panels resolved
    recursively). Templates read it via the shared `vox-runtime.js`:
    `vox.vars(el)` finds the script inside `el.closest('[data-composition-id]')`, so
    many mounted scenes in one document never collide (no element ids). This avoids HyperFrames variables, which only allow scalar types
    (`string`, `number`, `color`, `boolean`, `enum`).
  - a `<style>` block with tokens as CSS custom properties (`--tok-*`, spec 2) scoped
    to the scene root. If the sequence's style extends the template's declaring style
    (directly or through a chain), the sequence style's tokens are used, so
    `base/text-overlay` looks like `vox` in a `vox` sequence. Otherwise the declaring
    style's tokens are used, so a `vox` template keeps its look in any sequence.
  - the output of the template's optional build hook (spec 2), e.g. a projected map SVG.
- A media id that is not in the library fails compile with `MEDIA_MISSING`.
- Captions become one generated sub-composition from `deriveCaptions` and the preset's
  HTML.
- Preview audio: each audio-track clip becomes a timed `<audio>` element using
  `audio/<mediaId>.m4a` with static volume (`data-volume`), so the player has sound.
  Fades are approximated with a GSAP volume tween if the spike confirms it works;
  otherwise preview plays without fades. Muted tracks are skipped.
- SFX: if `sequence.sfx` is true, each scene's `sfxCues` become timed `<audio>`
  elements in preview.
- Referenced files are hard-linked (or copied across devices) into the build folder.

Compile is deterministic: the same project and version produce byte-identical output.

### Audio

Final audio never goes through HyperFrames. `src/audio/` builds one ffmpeg filter graph
from the model: every audio-track clip (`atrim` at `inMs`, `adelay` to `startMs`,
`volume`, `afade` for fades), SFX cues, track mutes, then `amix` with normalisation off
and a limiter. `render` renders the picture with HyperFrames (silent) and muxes it with
this mix. Audio and picture are both placed from the same frame-grid times, so sync
does not depend on the browser. Ducking (v1.1) adds `sidechaincompress` per track.

### Layer renderer (shared)

`renderLayers(projectId, sequenceId, layers)` renders chosen layers (a scene, a
transition, the captions, overlays) to ProRes 4444 MOV with alpha using
`hyperframes render --format mov`. It is used by:

- `export-timeline`, which needs scene and caption layers as MOVs;
- the hybrid export, if the spike fails: originals are composited with ffmpeg
  `overlay` in the same bottom-to-top order compile uses, then muxed with the audio
  mix. In that case preview (player) and export differ in implementation, and the
  spec's Goal 3 holds only visually; the integration test compares sampled frames of
  both within a tolerance.

### Spike (first implementation task)

HyperFrames targets HTML motion graphics. Long, video-heavy compositions are unproven.
The spike decides whether HyperFrames renders whole sequences, and measures preview
latency before the UI is designed around it.

Fixture (generated by script, no network): 90 s at 1080×1920, 30 fps, from one 1080p
source with a burnt-in frame counter and an audio click track:

- ≥ 40 cuts on `V1` of the same source (many `<video>` elements on one file);
- 8 scenes from `base` plus a stand-in `stack` (2 nested panels) and one scene with a
  video slot;
- an image clip with `push-in`, a `crossfade` transition, captions on;
- audio on `A1` linked to the cuts.

Pass bar (all must hold, measured on the M5):

1. **Cut accuracy**: at every cut, the rendered frame before and after the cut matches
   the ffmpeg-extracted reference frame (frame counter OCR or pixel diff); no ±1-frame
   error, no grey or black frames.
2. **A/V sync**: click-track onsets vs burnt-in flash frames differ by < 1 frame.
3. **Render speed**: ≤ 5× real time at `--quality draft` (≤ 7.5 min for 90 s).
4. **Preview**: `<hyperframes-player>` plays the preview build at ≥ 24 fps with no
   stall over 200 ms, and seeking to a cut shows the right frame within 300 ms. This is
   measured in the production setup: a minimal Electron window (pinned Electron version
   of spec 4) whose renderer page is on `vox-app://`, the build served cross-origin
   from `vox-media://` with range requests under the exact CSP of spec 4, the player with
   `sandbox-origin="opaque"` (no `allow-same-origin`, which the player otherwise adds by
   default), and vendored runtime/GSAP. Opaque mode drops the player's parent-media
   audio proxy and direct timeline access, so the spike also checks that `<audio>`
   inside the composition stays within 1 frame of picture during play and after seeks.
5. **Memory**: peak RSS of the render under 12 GB.
6. **Op → preview latency**: one `trimItem` → in-memory compile → player update in
   < 1 s; the spike tries a scene-only patch path (replace one instance file and
   remount) and a full reload, and records both.
7. **Mechanisms**: per-instance `data-vox-vars` injection with 8 scenes mounted at once
   (`vox.vars(el)` returns each scene's own data), scoped token styles, muted video with
   separate `<audio>`, and GSAP volume tweens either work or are recorded as not
   working.

Each item gets up to 3 measurement attempts (fixing the measuring script between attempts
is allowed). An item still unmeasured after the third attempt counts as failed. The
outcome follows from the numbers through the list below (plan D-10), so GATE 1 needs no
new design work.

Outcome:

- All pass → HyperFrames renders whole sequences.
- 1, 3 or 5 fail → hybrid export through the layer renderer.
- 2 fails → re-measure with the picture rendered silent and muxed with an ffmpeg mix of
  the click track (the real export path; see "Audio"). If that passes, item 2 passes. If
  it still fails, the cut timing itself is wrong, and the result counts as an item 1 failure.
- 7 fails, per mechanism:
  - `data-vox-vars` lookup: each scene instance file inlines its own variables as a
    JS object literal in a scoped `<script>` that registers them on its composition root.
  - Scoped tokens: tokens are written as literal values into each instance file's styles.
  - Muted `<video>` + separate `<audio>`: preview plays without sound; export is
    unaffected.
  - GSAP volume tweens: preview has no fades (already allowed under "Compile").
  The chosen alternative is written into "Compile" before phase 03 starts.
- 4 fails only in opaque mode and passes with `allow-same-origin` → item 4 passes with
  the sandbox fallback: the player keeps the `vox-media://` origin (no preload, no IPC
  access) with `allow-same-origin`, and the CSP's `connect-src 'none'` remains the guard.
  The Preview fallback is not used.
- 4 fails in both sandbox modes, or 6 fails → spec 4 switches to its pre-written "Preview
  fallback" (scene-only player, video via native `<video>` elements outside the player)
  before UI work starts.

The pinned HyperFrames version and the measured numbers are written into this spec.

## Stages

Every stage is idempotent: outputs are keyed by a hash of their inputs under `cache/`,
and a rerun with unchanged inputs is a no-op. Stages run as jobs (below).

| CLI | Does |
|---|---|
| `vox doctor` | checks ffmpeg, ffprobe, yt-dlp (+ `yt-dlp-ejs` and deno or node, offers `yt-dlp -U`), uv env, Chromium for HyperFrames, pinned HyperFrames version, model downloads and their licences; prints fixes |
| `vox paths [--json]` | prints the resolved projects folder, styles folders and tool paths (see "Project folder") |
| `vox quick <url\|path> [--count 3] [--length 30-60] [--name n] [--render]` | quick clips (below): new project, ingest, transcribe, facetrack, `count` captioned 9:16 clips with no style beats and no AI key needed; `--render` also writes MP4 (subtitles burned in) + SRT per clip |
| `vox new <name>` | creates a project with one empty 9:16 sequence; `styleId` is `vox` if installed, else `base` |
| `vox ingest <project> <url\|path>...` | download or copy; content-sniffed type; ffprobe metadata; proxy, extracted audio, thumbs, peaks; `addMedia`. Text files (`.txt`, `.md`, `.fountain`, `.pdf`) become `document` media with plain text at `media/<id>.txt` (`.pdf` text via `pypdf`, BSD, in `py/`). `--no-proxies` (API `{ proxies: false }`) skips proxy, thumbs and peaks; styles Part C uses it for reference videos |
| `vox transcribe <project> [mediaId...]` | mlx-whisper (pinned repo), auto language, word timestamps |
| `vox facetrack <project> <mediaId>` | MediaPipe Tasks `FaceDetector` (full-range model, downloaded `.tflite`) at 5 fps; tracks every face, picks the largest by default (`faceIndex` overrides); smoothed → crop-centre keyframes |
| `vox assets search <project> "<query>" [--source commons,openverse]` | candidates with licence + author, stored in `cache/assets/<queryHash>.json`; the job result returns them |
| `vox assets fetch <project> <candidateId>` | download, record licence, `addMedia` (origin `archive`) |
| `vox assets cutout <project> <mediaId>` | rembg (pinned permissive model) → transparent PNG as a new media item; refused for no-derivatives licences |
| `vox assets generate <project> "<prompt>" [--style id] [--provider id]` | image from a registered `ImageProvider` → new media item (origin `generated`); fails with a hint when none is registered |
| `vox op <project> <opName> '<json>'` | apply an edit operation |
| `vox undo <project>` / `vox redo <project>` / `vox history <project>` | history |
| `vox snapshot <project> <name>` | named snapshot |
| `vox compile <project> [--seq id] [--mode preview\|render]` | writes `build/` |
| `vox preview <project> [--seq id]` | compile + `npx hyperframes play` |
| `vox frames <project> [--seq id] --at-ms 1200,5000` | still PNGs of the compiled sequence at canvas size |
| `vox media-frames <project> <mediaId> --at-ms 1200,5000` | source stills via ffmpeg (agent footage tagging) |
| `vox render <project> [--seq id] [--range-ms a-b] [--quality draft\|standard\|high] [--captions burn\|none] [-o file]` | final MP4 (quality passed explicitly; HyperFrames' own default is `looks`); `--captions none` renders without subtitles (default `burn` when captions are enabled) |
| `vox export-captions <project> [--seq id] --format srt\|vtt` | caption file from `deriveCaptions` |
| `vox export-timeline <project> [--seq id]` | `.otio` timeline referencing originals + layer MOVs (Resolve 18.5+ reportedly imports OTIO natively; secondary sources only, so done-when #5 is the gate, including alpha on the MOV layers) |
| `vox credits <project>` | licence/attribution list for archive assets used |

`<project>` in every command is the project id, or a project name that matches exactly
one project; an ambiguous name fails and lists the matching ids.

### Quick clips

The simple path (plan D-11): URL in, captioned clips out, no style work and no AI key.
`quickClips(projectId, mediaId, { count = 3, minMs = 30000, maxMs = 60000, scorer? })`
runs as job kind `quickClips` after ingest, transcribe and facetrack:

1. Split the transcript into sentence units at words ending a sentence (`.`, `?`, `!`
   and their equivalents) or at pauses ≥ 700 ms.
2. Candidates are runs of whole units whose length is within `[minMs, maxMs]`, so every
   clip starts and ends on a sentence boundary.
3. Score each candidate. The built-in heuristic scorer uses speech ratio (spoken time ÷
   length) minus 0.5 per internal pause over 1.5 s; ties go to the earlier start. A
   registered scorer (`engine.quickClips.registerScorer(id, fn)`; the agent registers an
   LLM scorer when a `fast` model exists, spec 3) gets each candidate's text and times
   and returns a score per candidate; the heuristic is the fallback when it fails.
   `scorer` omitted → the most recently registered scorer, else the heuristic;
   `scorer: 'heuristic'` forces the built-in one.
4. Pick the top `count` candidates that do not overlap. Fewer fitting candidates means
   fewer clips, reported in the result.
5. Each pick becomes a sequence in one `batch`: name "Clip <n>", 1080×1920 at the
   supported fps nearest the source, `styleId: 'base'`, `sourceRange` set, the range
   placed once as a linked pair (`V1` with `facetrack` framing when a face track exists,
   else `cover`; `A1` speech), captions on (`sourceTrackIds: ['A1']`, preset
   `base/plain`, `maxWords` 3). No scenes, transitions or overlays.

The result lists the sequence ids, the chosen ranges with their text, and the scorer
used. Selection is deterministic for the same transcript, options and scorer output.
Styling is a separate, optional step (spec 3 "Stylize"; or by hand in the app).

Encoding: ffmpeg comes from Homebrew (plan D-05), whose build includes libx264. Proxies
use libx264 at 540p with `-crf 23` and a keyframe every 0.5 s (`-g` and `-keyint_min` set
from the source fps). `render` muxes HyperFrames' H.264 output with the audio mix using
`-c:v copy` and AAC audio, so the picture is encoded only once.

### Ingest hardening

- URLs: only `http(s)`. yt-dlp does its own DNS and follows redirects, so a pre-check
  of the host is not enough. Instead, every yt-dlp network connection goes through a
  small local filtering proxy started by the engine (`--proxy http://127.0.0.1:<port>`).
  The proxy resolves each `CONNECT`/request host itself and refuses private, loopback,
  link-local and multicast addresses, connecting to the IP it checked (no DNS-rebinding
  window). Archive and image downloads by the engine use the same check in-process.
- yt-dlp runs with `--ignore-config --no-plugin-dirs --no-playlist
  --max-filesize 4G -f "bv*[height<=1080]+ba/b[height<=1080]" --merge-output-format mp4`
  (`--playlist` opt-in), output to an engine-generated name, never the remote title.
  YouTube needs `yt-dlp-ejs` and a JS runtime: deno is preferred (yt-dlp's default);
  if only node exists, the engine passes `--js-runtimes node` and `vox doctor` warns
  that yt-dlp considers node less safe.
- ffmpeg and ffprobe run on untrusted files with `-format_whitelist` limited to the
  demuxers needed for the detected type (e.g. `mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,
  mp3,wav,aac,ogg,flac,image2,png_pipe,jpeg_pipe`), so HLS, concat and other
  playlist-style demuxers that open further files are never used. `-protocol_whitelist
  file,pipe` is kept as a second layer against network protocols; it does not by itself
  block local reads.
- File type is detected from content (ffprobe format / magic bytes), not the extension.
  SVG and HTML are never accepted as media; images are re-encoded to PNG/JPEG.
- A local path is accepted only from the CLI or from the UI's upload/import; the agent
  rules for paths are in spec 3.

### Archive assets and licences

- Licence allowlist: CC0, Public Domain Mark, CC BY, CC BY-SA. BY-SA results carry a
  warning that ShareAlike may apply to the video. NC and ND are excluded (ND forbids
  cutouts and collage). Other licences are dropped from results.
- Openverse queries use `license=cc0,pdm,by,by-sa` and `page_size` ≤ 20 (anonymous
  limit).
- Commons requests send a User-Agent `VoxStudio/<version> (<contact>)`; `vox doctor`
  asks for the contact (an email or URL) once, stored in `~/.vox/config.json`.
  Without it, requests are throttled to 10/min. `Artist` HTML is sanitised to text.

### Image generation provider

```ts
ImageProvider {
  id: string
  generate(req: { prompt; width; height; seed? },
           opts: { signal: AbortSignal; onProgress?(p: number): void }) → Promise<path>
}
```

v1 ships no local provider; spec 3 registers API providers (e.g. OpenRouter image
models) behind this interface. v1.1 adds `mflux` with Z-Image-Turbo (Apache-2.0, not
gated) as the local default; FLUX.1-schnell is optional and needs the user to accept
its terms on Hugging Face and supply a token, which `vox doctor` explains.

## Library API (for packages agent, cli, desktop)

`src/api.ts` (package entry `@vox/engine`) is the only import other packages use, plus one
subpath export, `@vox/engine/paths` (the path rule alone, for the desktop app's main
process, which must not load the whole engine):

```ts
openEngine({ projectsDir, stylesDirs: string[], tools?: ToolPaths }): Engine
readConfig() → Config; writeConfig(patch) → Config   // ~/.vox/config.json (src/config.ts)
// projectsDir: see "Project folder" (default ~/Movies/Vox Studio)
// stylesDirs: searched in order; a duplicate id is an error (spec 2)
// ToolPaths: ffmpeg, ffprobe, yt-dlp, deno, uv, py env, Chrome for HyperFrames;
//   default: the app's tools directory, then PATH

Engine {
  listProjects(), createProject(name), getProject(id), deleteProject(id)
  applyOp(projectId, op, opts) → { version, changes }
  undo(projectId), redo(projectId), undoRun(projectId, runId)
  history(projectId, { sinceVersion? })
  snapshot(projectId, name), listSnapshots(projectId)
  compile(projectId, sequenceId, opts) → BuildResult;  writeBuild(result) → buildDir
  captions(projectId, sequenceId) → CaptionChunk[]      // wraps deriveCaptions
  styles: { list(), get(styleId), accept(styleId), remove(styleId) }  // spec 2
  geo: { search(query) → places }     // offline Natural Earth populated places
  redactor: { addSecrets(values: string[]), redact<T>(value: T) → T }   // src/redact.ts
  imageProviders: { register(p), list() }
  quickClips: { registerScorer(id, fn), scorers() }     // see "Quick clips"
  frames(projectId, sequenceId, atMs[]) → png paths      // compiled stills, cached
  mediaFrames(projectId, mediaId, atMs[]) → png paths    // source stills, cached
  jobs: {
    start(kind, args) → jobId   // ingest | transcribe | facetrack | quickClips | assets.search |
                                // assets.fetch | assets.cutout | assets.generate |
                                // render | frames | exportCaptions | exportTimeline
    register(kind, handler)     // other packages add kinds, e.g. agent's style.extract
    get(jobId) → { status, progress, result?, error? }
    cancel(jobId), list(projectId)
  }
  on(event, handler)   // 'project.changed' | 'job.started' | 'job.progress' |
                       // 'job.done' | 'job.failed' | 'job.cancelled'
}
```

**Config.** `src/config.ts` is the only code that reads or writes `~/.vox/config.json`;
the engine, agent, CLI and app all go through it. It owns the zod schema (the provider,
role and limit sections are defined in spec 3; `contact` and `projectsDir` are
defined here), writes with
mode `0600` from the very first write (temp file, `fsync`, rename), and a `writeConfig`
patch replaces only the keys it names, so one writer never drops another's fields.

**Redactor.** The secret redactor of spec 3 lives in the engine, so `VoxError.cause` is
redacted without the engine importing the agent. It removes registered literal values
(the agent registers every key value it reads with `redactor.addSecrets`) and the
key-like patterns listed in spec 3.

Jobs run in-process with a concurrency limit of 2 (transcription and image generation
hold the GPU, so at most one of those at a time). Cancelling aborts the signal and kills
the child process. The CLI is a thin wrapper over this API; every command supports
`--json`.

## Error handling

- All failures raise `VoxError { code, message, hint, cause? }`. The CLI prints
  `hint`; `--json` prints the object. Exit code 1.
- External tool failures (yt-dlp, ffmpeg, Python, HyperFrames) capture the last 40
  lines of stderr into `cause`, after passing it through the engine's redactor
  (`engine.redactor`, see "Library API").
- Network stages retry 3× with backoff. If an archive search returns nothing, the
  stage says so; it never silently substitutes generated images (the agent decides).
- `ingest` accepts a local path when yt-dlp fails; the error hint says so.

## Testing

- **Unit (vitest)**:
  - every operation: overlap rules, insert/ripple across sync-locked tracks, linked
    items, trim/split math on the frame grid at 24/25/30/60 fps (no 1-frame gaps after
    100 random splits), locked tracks, track-kind rules, batch atomicity, STALE, `removeMedia` leaving the file on disk;
  - history: normalise/denormalise round-trip, multi-level undo then redo returns the
    exact project, redo cleared by a new op, `undoRun` with and without conflicts;
  - crash recovery: kill between history append and project write (both orders),
    torn last line, lockfile with a dead pid;
  - captions: trims, overrides (multi-word `text`, `text: null`, `startMs`/`endMs`),
    `breakAfter`, re-transcription orphans, chunking, overlap priority, word clamping;
  - quick clips: sentence-bounded ranges within `[minMs, maxMs]`, no overlaps,
    deterministic picks, scorer fallback, sequence shape (plan D-11);
  - path rule: `..`, encoded `..`, absolute, NUL, symlink escaping the project;
  - ingest guards: the filtering proxy refuses private-IP hosts, redirects to private
    IPs and a DNS name that resolves to 127.0.0.1; a concat/HLS file disguised as
    `.mp4` is rejected by `-format_whitelist`; an SVG disguised as PNG is rejected;
  - template variable validation, including nested `stack` panels.
- **Compile snapshots**: fixture projects → in-memory build snapshots.
- **HyperFrames contract tests**: `npx hyperframes lint --json` on the emitted build
  reports zero errors, and a 3 s fixture renders with `render --strict-all` and the
  expected frames, on the pinned version. A
  HyperFrames upgrade must pass these before the pin changes.
- **Audio graph**: the ffmpeg graph for a fixture timeline matches a snapshot; rendered
  click-track offsets are within 1 frame.
- **Python tools (pytest)**: request/response schemas; transcribe on a fixture.
- **Offline fixture**: `test/fixtures/make.sh` builds a 20 s talking-head stand-in
  with ffmpeg `testsrc2` video and macOS `say` speech, plus the spike fixture.
- **Integration**: fixture → ingest (local) → transcribe → place linked clips + one
  `base/title` scene → captions → render draft → assert duration, resolution, audio
  stream, 3 non-blank sampled frames, and SRT export.
- **Manual end-to-end**: one real YouTube URL through ingest → render.

## Done when

1. The spike result and the pinned HyperFrames version are written into this spec.
2. `vox doctor` passes on the M5 machine.
3. `pnpm test` passes from a clean checkout.
4. From a real YouTube URL, CLI commands alone produce a 9:16 MP4 with a face-tracked
   speaker clip, one `base/title` scene, a transition and captions, plus an SRT file.
5. `vox export-timeline` produces an `.otio` that opens in DaVinci Resolve with clips
   and layer MOVs in place. If Resolve rejects it, FCPXML through `otio-fcpx-xml-adapter`
   (moved forward from v1.1) gets the same check. If both fail, the item passes only with
   README steps that put the layer MOVs in place by hand, tested once by the owner
   (plan D-10).
6. Killing `vox op` mid-write never loses or corrupts a project (recovery test).
7. `vox quick <url>` with no provider configured produces 3 captioned 9:16 clips
   (MP4 + SRT with `--render`), and an edited caption word shows in both the SRT and the
   rendered MP4 (plan D-11).
