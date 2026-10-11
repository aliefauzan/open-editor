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
- Speech gate and framing (plan D-15): Silero VAD (MIT) runs as ONNX through
  `onnxruntime` (MIT), with no torch: the `silero-vad` pip package pulls in torch, so
  its ONNX model file is vendored at `py/vox_py/models/silero_vad.onnx` with its MIT
  licence and SHA-256 (pinned in plan R5), and `vox_py.vad` calls it directly. Framing falls back to Apple Vision through
  `pyobjc-framework-Vision` (MIT), which is now a v1 dependency, not only styles Part C.
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
4. Ingest, transcription, shot detection, face tracking, asset fetching and cutouts are cached,
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
  ducking (approach noted under "Audio"), FCPXML export, and clip speed (designed in
  "Clip speed", plan D-62).

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
      src/render/            # layer renderer (ProRes 4444 MOV) + hybrid compositor
      src/stages/            # ingest, transcribe, shots, facetrack, assets, render (+ mux,
                             # uses src/render), export, audioQa, quickClips
                             # (shots.ts runs ffmpeg `scdet` itself; no Python)
      src/export/target.ts   # export targets {file}|{dir}: temp + rename, no silent replace
      src/net/               # filtering proxy, private-address check
      src/errors.ts          # VoxError + codes
      src/log.ts             # logs/engine.log writer, rotated at 5 MB, 3 files (plan D-16)
      src/text/fillers.ts    # filler word lists per language (plan D-15)
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
    vox_py/vad.py            # Silero VAD (ONNX, onnxruntime); used by transcribe.py
    vox_py/models/silero_vad.onnx  # vendored, MIT; SHA-256 in plan R5
    vox_py/facetrack.py      # MediaPipe Tasks FaceDetector + Apple Vision body and
                             # saliency (pyobjc-framework-Vision)
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
  media/<mediaId>.cfr.mp4    # constant-frame-rate copy of a VFR video (plan D-15)
  proxies/<mediaId>.mp4      # 540p H.264, all-keyframe-every-0.5 s, for preview
  audio/<mediaId>.m4a        # extracted audio for preview <audio> elements
  thumbs/<mediaId>.jpg       # sprite sheet (1 frame / 2 s) for the UI
  peaks/<mediaId>.json       # audio waveform peaks for the UI
  transcripts/<mediaId>.json
  shots/<mediaId>.json       # shot list { startMs, endMs }[] (see "Shots and framing")
  facetracks/<mediaId>.json
  build/<sequenceId>/        # compiled HyperFrames project (regenerated)
  renders/                   # default export folder (CLI without -o/--out-dir; agent never exports)
  renders/qa/<sequenceId>/   # audio QA: qa.json, qa.png, LISTEN.md (see "Audio QA"); last run kept
  runs/<runId>.jsonl         # agent run records (spec 3 "Agent loop"); kept with the project
  logs/engine.log            # engine log lines (e.g. migrations); rotated at 5 MB, 3 files kept
  snapshots/<name>.json      # named project snapshots (names `auto-*` reserved); auto-pre-migrate-v<N>.json before a migration
  cache/                     # hash-keyed stage outputs; cache/assets/<queryHash>.json
  cache/prerender/<hash>.mp4 # preview pre-render cache, only if enabled (see "Layer renderer")
```

Exports may also be written outside the project folder, but only to a path the user
chose (see "Export targets").

All paths in `project.json` are relative to the project folder. Path rule, used by the
loader, compile, and the desktop app's `vox-media://` protocol handler: decode once; reject NUL bytes,
absolute paths and any `..` segment; resolve with `realpath` (follows symlinks); accept
only if the result starts with `realpath(projectDir) + path.sep`. Ingested folders are
copied, never symlinked.

## Data model (`project.json`)

### Time and the frame grid

A frame rate is a rational `{ num, den }` from a fixed set (plan D-15): 24/1, 25/1, 30/1,
60/1, 24000/1001, 30000/1001 and 60000/1001 (23.976, 29.97 and 59.94 fps). Times stay
integer milliseconds.

Timeline times lie on the sequence's frame grid:
`ms(f) = Math.round(f * 1000 * den / num)` for an integer frame `f`, and
`frame(ms) = Math.round(ms * num / (1000 * den))`, which round-trips exactly for grid
values at every rate in the set.
Every operation snaps an item's start and end to the grid, then stores
`durationMs = end − start`, so adjacent items never gap or overlap by a frame. Compile
uses `startFrame = frame(startMs)` and `endFrame = frame(startMs + durationMs)`.
Changing a sequence's fps re-snaps all items in that sequence (one history entry).
Source offsets (`inMs`) are snapped to the **source** frame grid (`MediaItem.fps`), not
the sequence grid, so a 29.97 source in a 30 fps sequence never lands between source
frames. Media with no `fps` (audio, images) use the sequence grid.

### Schema

Loading rejects unknown fields, so a new field always comes with a `schemaVersion` bump
and a load-time migration. The plan D-15 fields below are part of `schemaVersion: 2`:
the contracts are not frozen until phase 02, so they need no migration. `schemaVersion: 3`
is the v1.1 schema (plan D-62): it adds `MediaClip.speed` (see "Clip speed"), and its
migration from 2 only sets the number.

```ts
Fps { num: number; den: number }   // one of 24/1, 25/1, 30/1, 60/1,
                                   // 24000/1001, 30000/1001, 60000/1001


Project {
  schemaVersion: 3
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
  fps?: { num: number; den: number }   // video only: source rate, any value
                             // (for VFR, the CFR copy's rate); see "Ingest analysis"
  vfr?: boolean              // video only: variable frame rate detected at ingest
  cfrPath?: string           // VFR only: media/<id>.cfr.mp4, used instead of `path`
  loudness?: { integratedLufs: number; truePeakDb: number }  // audio-bearing media
  shotsPath?: string         // video only: shots/<id>.json
  origin: { type: 'url' | 'upload' | 'archive' | 'generated'
            url?: string; license?: string; licenseUrl?: string
            author?: string; attribution?: string; prompt?: string }
  transcriptPath?: string; transcriptRev?: string  // rev = hash of transcript file
  facetrackPath?: string
  tags: string[]; description?: string             // filled by the agent
}

Sequence {
  id: string; name: string
  canvas: { width: number; height: number; fps: Fps }   // default 30/1
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
  duck?: boolean             // audio tracks only (v1.1, plan D-61): lowered under the speech tracks in the mix
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
  frame?: { mode: 'cover' | 'contain' | 'facetrack' | 'auto' | 'manual'
            x?: number; y?: number; scale?: number; faceIndex?: number
            stability?: 'locked' | 'smooth' | 'follow'     // default 'smooth'
            trackSpeed?: 'slow' | 'normal' | 'fast'        // default 'normal'
            keyframes?: { atMs: number; x: number; y: number; scale: number }[] }
            // atMs relative to the item start (see "Shots and framing")
  motion?: { type: 'none' | 'push-in' | 'pan'; amount: number }   // images only
  // audio tracks:
  volume?: number            // linear gain 0..2, default 1
  fadeInMs?: number; fadeOutMs?: number   // default 0
  denoise?: 'off' | 'light' | 'strong'    // default 'off' (see "Audio")
  // video and audio media (v1.1):
  speed?: number             // playback speed, default 1 (see "Clip speed")
}

SceneClip extends ItemBase {
  type: 'scene'
  template: string           // '<styleId>/<templateName>', e.g. 'vox/paper-collage'
  templateVersion: string    // the template's full semver when placed; compile compares majors
  variables: Record<string, unknown>   // validated against the template's schema
  sfxOff?: string[]          // names of this scene's sfxCues that are muted (plan D-14)
}

CaptionTrack {
  enabled: boolean
  sourceTrackIds: string[]   // audio tracks whose clips provide the spoken words
  preset: string             // full id '<styleId>/<presetName>'
  maxWords: number           // words per chunk, default 3
  maxLines: number           // lines per chunk, default 1
  maxCharsPerLine: number    // default 18
  gapFillMs: number          // default 400 (see "Captions")
  autoEmphasis?: boolean     // default false: mark numbers and capitalised non-initial words
  position: { yPct: number } // default from the preset
  overrides: { wordKey: string; text?: string | null; breakAfter?: boolean
               startMs?: number; endMs?: number    // startMs/endMs in source-media time
               emphasis?: boolean }[]
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

### Transcripts (plan D-15)

`transcripts/<mediaId>.json` is written by the `transcribe` stage. Times are source-media
milliseconds.

```ts
Transcript {
  language: string
  words: TranscriptWord[]    // in time order; wordIndex = position in this array
  speechRegions: { startMs: number; endMs: number }[]   // from the speech gate
}

TranscriptWord {
  text: string               // '' for a pause
  startMs: number; endMs: number
  kind: 'word' | 'pause' | 'repeat' | 'filler'
}
```

`kind` is computed by the engine after Whisper returns, never by Whisper:

- `filler`: the word is in the filler list for the transcript's language
  (`src/text/fillers.ts`).
- `repeat`: a 1–3-word n-gram that is repeated back to back; the earlier copy is marked,
  so the speaker's restart is kept.
- `pause`: a gap of at least 350 ms (the `removePauses` default `minPauseMs`) between two
  words, stored as a pseudo-word with empty `text`.
- `word`: everything else.

Pause pseudo-words count in `wordIndex`, so they have a `wordKey` like any word.

### Captions

`deriveCaptions(project, sequenceId) → CaptionChunk[]` is a pure function exported from
the model module, used by compile and the SRT/VTT exporter. The library API wraps it as
`engine.captions(projectId, sequenceId)` for the UI caption lane.

```ts
CaptionChunk { startMs: number; endMs: number; lines: { words: CaptionWord[] }[] }
CaptionWord  { key: string; text: string; startMs: number; endMs: number; emphasis: boolean }
// key = wordKey; all times are timeline ms
```

Presets get each word's times, so they can style read, active and unread words
(karaoke). Case, punctuation and the safe area are preset settings (spec 2), not track
fields; compile applies `case` and `stripPunctuation` (see "Compile").

- For each `MediaClip` on a source audio track, take transcript words whose midpoint lies
  in `[inMs, inMs + durationMs)`, shift them to timeline time, and clamp them to the clip.
  Pause pseudo-words (`kind: 'pause'`) are never captions; fillers and repeats are,
  until they are cut.
  Zero-length words get one frame. Overlapping words are trimmed to the next word's start.
- Apply overrides. `wordKey` = `<mediaId>:<transcriptRev>:<wordIndex>`, so a
  re-transcription orphans old overrides instead of misapplying them; orphans are
  reported by `vox doctor <project>` and dropped by `setCaptions`.
- Chunk by `maxWords`, by pauses over 300 ms, at clip boundaries and after any word
  with `breakAfter`.
- Lines (plan D-15): words fill a line up to `maxCharsPerLine` characters (a single
  longer word gets a line of its own). A chunk that would need more than `maxLines`
  lines ends early, and the next chunk starts with the word that did not fit.
- Emphasis: a word's `emphasis` is its override's `emphasis` when set. Otherwise, with
  `autoEmphasis`, numbers and capitalised words that are not the first word of a
  sentence are emphasised; without it, no word is.
- Timing: inside a chunk, each word's end extends to the next word's start, so the
  active word never blinks off. A chunk's end extends to the next chunk's start when the
  gap between them is shorter than `gapFillMs`.
- Where two source tracks overlap in time, the lower track index wins.
- For languages written without spaces (e.g. Japanese, Chinese), Whisper's tokens are
  used as-is and chunking is by character count (`maxWords × 4`).

Trimming or moving a clip keeps captions correct because they are derived. SRT and VTT
write one cue per chunk and one text line per chunk line; the preset's `case` and
`stripPunctuation` do not apply to them.

Editing captions (plan D-11): transcripts are sometimes wrong, so every caption is
editable through `setCaptions` overrides, one undoable entry per edit:

- `text` replaces a word's text. It may contain several words (a word Whisper missed is
  added by editing its neighbour); they share the word's time, split evenly, and count
  as separate words for chunking. `text: null` hides the word.
- `startMs`/`endMs` correct a word's timing (source-media time; the result is shifted
  and snapped to the frame grid like any word).
- `breakAfter` ends a chunk after the word; it is how chunks are split or (by removing
  it) merged.
- `emphasis` turns emphasis on or off for one word, over `autoEmphasis` (plan D-15).
- The transcript itself is never edited, so "reset" removes the overrides.
- Each override is its own history entity (`captionOverride:<seqId>/<wordKey>`, see
  "History"), so a word edit records one small entity.

### Transitions

`transitionIn` on an item describes the cut between it and the previous item on the
same track. `template` names a transition template (kind `transition`, spec 2), e.g.
`base/crossfade`, `vox/paper-tear`. Compile mounts it on a layer directly above the
track, centred on the cut, for `durationMs`. Templates that blend the two shots (e.g.
crossfade) need source handles: the outgoing and incoming media must extend
`durationMs / 2` beyond the cut. If not, the op fails with `NO_HANDLES` and
the hint suggests a cover-style transition. Items still never overlap in the model.
A quick clip is one source range with no handles beyond `sourceRange`, so Stylize and
the clipper default to cover-style transitions at clip edges (plan D-15).

### Clip speed (v1.1, plan D-62)

A media clip plays its source faster or slower with `speed` (default 1; the field is absent at 1).

- **Range**: 0.25 ≤ `speed` ≤ 4, in steps of 0.01, for a clip on a video track; 0.5 ≤ `speed` ≤ 2
  for a clip on an audio track, the range where `atempo` keeps the sound within one frame (spike
  below). Image clips and scenes have no speed.
- **Source span**: a clip uses the source range `[inMs, inMs + span)` with
  `span = Math.round(durationMs × speed)`, so the duration rule is
  `inMs + durationMs × speed ≤` the media duration. Timeline time `t` shows source time
  `inMs + (t − startMs) × speed`; source time `x` lands at `startMs + (x − inMs) / speed`.
  `startMs`/`durationMs` stay on the sequence grid and `inMs` on the source grid.
- **Ops**: every op that touches source offsets uses the span and this mapping: `trimItem` from
  the start moves `inMs` by the trimmed time × speed, `splitItem` gives the right part
  `inMs + offset × speed`, and `rippleDelete`, the `replaceMedia` clamp, the fps re-snap and the
  `NO_HANDLES` check (handles of `durationMs / 2 × speed` in the source) do the same.
  `setClipSpeed { sequenceId, itemId, speed, unlinked?, onOverlap = 'error' }` keeps `startMs`,
  `inMs` and the source span, so a slower clip gets longer: `durationMs` = the span / `speed`,
  snapped, and cut back to the media end if rounding passes it. Linked media clips change with
  it unless `unlinked`. A longer clip that would overlap the next item fails `OVERLAP` with
  `onOverlap: 'error'`; `'ripple'` shifts every later item on the clip's tracks and the
  sync-locked tracks by the change (a shorter clip closes its gap). A sound clip outside
  0.5–2× fails `VALIDATION` with a hint to unlink it. `speed: 1` removes the field.
- **Captions and word ranges** (`deriveCaptions`, `removePauses`, `removeWords`) take the words
  whose midpoint lies in the source span and map them with the formula above, so captions
  follow the faster or slower speech.
- **Compile**: a video clip's `<video>` gets `data-playback-rate="<speed>"`;
  `data-media-start` stays the source offset and `data-duration` the timeline length (the
  pinned HyperFrames reads the rate in render and in the player). Preview `<audio>` elements get
  the same attribute (the browser keeps the pitch). `facetrack`/`auto` paths are built on the
  source span with their keyframe times divided by `speed`; manual keyframes stay item-relative
  timeline times.
- **Audio (final mix)**: a sped clip's chain is `atrim` of the source span with a preroll of 1024
  samples at 48 kHz before `inMs` (silence where the source starts later) → resample →
  `afftdn` → `atempo=<speed>` → `atrim` to the timeline length → gain-to-target, `volume`,
  `afade`, `adelay`. ffmpeg's `atempo` drops about its first 1024 input samples, so without the
  preroll every sped clip sounds early (up to one frame at 0.5×).
- **Exports**: SRT/VTT follow the derived captions; an OTIO clip keeps its timeline length and
  gets a `LinearTimeWarp` effect with `time_scalar = speed`. `engine.view` items carry `speed`
  when it is not 1.
- **Schema**: `speed` is a new field, so `schemaVersion` is 3. The load-time migration 2 → 3
  only sets the number (absent `speed` = 1), after the `snapshots/auto-pre-migrate-v2.json`
  copy. Version 3 is the v1.1 schema; other optional v1.1 fields join it without a second bump.
  A v1.0 engine refuses a v3 project with `SCHEMA_TOO_NEW` and writes nothing; the snapshot is
  the way back.
- **Spike** (plan 14e, `spike/bench/speed.ts`, evidence `docs/evidence/phase-14e/`): HyperFrames
  0.8.145 renders `data-playback-rate` frame exact (960 of 960 frames at 0.25×, 0.5×, 1×, 2× and
  4× show the expected source frame). Flash-to-click offset after the mux: max 33.31 ms with plain
  `atempo` (0.5×), max 9.35 ms with the preroll; isolated `atempo` runs with the preroll stay
  within ±15 ms for 0.5–2×, and two chained stages below 0.5× reach 53 ms.

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
write tools are generated from this table, so every op is reachable by the agent: each
workflow exposes a small set directly and the rest through `describe_tool`/`call_tool`
(agent spec "Tools", plan D-15).

| Operation | Purpose |
|---|---|
| `addMedia`, `updateMedia`, `removeMedia` | library (remove fails if any clip uses it; it removes the library entry only and never deletes files on disk) |
| `replaceMedia` | point every clip using media A at media B (same kind); clamps out-of-range clips and reports them |
| `addSequence` | creates a sequence with default tracks `V1`, `V2`, `A1`, `A2` and captions off |
| `updateSequence`, `duplicateSequence`, `removeSequence` | update covers name, canvas (re-snaps on fps change), styleId, sfx, overlays |
| `addTrack`, `updateTrack`, `removeTrack`, `reorderTracks` | tracks |
| `placeClip` | put a media clip on a track at a time (`withAudio`, `onOverlap`) |
| `updateClip` | change a media clip's `frame`, `motion`, `volume`, fades or `denoise` (plan D-18) |
| `addScene`, `updateScene` | add/edit a scene clip; `updateScene` may switch to a compatible template: every required variable of the target exists in the scene's variables with the same JSON-Schema type, and slot kinds (`media`, `geo`, `template`) match by key; variables the target does not declare are dropped and listed in the result |
| `moveItem` | change track and/or start time (`onOverlap`) |
| `trimItem` | change start/in/duration from either edge |
| `splitItem` | split at a timeline time into two items (linked items split too) |
| `removeItem` | delete an item (and linked items unless `unlinked: true`) |
| `rippleDelete` | delete a range and close the gap on the track and all sync-locked tracks |
| `link`, `unlink` | set or clear `linkId` on items |
| `setTransition` | set or clear `transitionIn` on an item |
| `setCaptions` | enable/configure captions, word overrides (including `emphasis`) |
| `setClipSpeed` | change a media clip's speed; keeps its source range (v1.1, see "Clip speed") |
| `removePauses` | `{ sequenceId, minPauseMs = 350, keepMs = 80, kinds = ['pause'], wordKeys?, dryRun? }`: cut pauses (and, if `kinds` adds `'filler'` or `'repeat'`, those words) from the spoken audio; `wordKeys` limits the cut to the listed ranges; see below |
| `removeWords` | `{ sequenceId, wordKeys[], dryRun? }`: text-based cutting; cut the named words from the spoken audio |
| `pasteItems` | place copied items (serialised items with new ids) at a time on mapped tracks |
| `restoreSnapshot` | replace sequences and media with a snapshot's (one history entry) |
| `batch` | apply a list of operations atomically (all or nothing, one history entry) |

`removePauses` and `removeWords` (plan D-15) find their words the way `deriveCaptions`
does (the caption source tracks; `A1` when captions are off) and map each word to a
timeline range. A pause range keeps `keepMs` of silence (half at each edge); a pause
shorter than `minPauseMs` is kept. With `wordKeys?: string[]`, only the pause, filler and
repeat ranges whose word keys are listed are removed, still keeping `keepMs` at the edges;
this is how a ticked subset of the review list is applied. Ranges are snapped to the
frame grid and merged where they touch. The op expands to one `batch` of `rippleDelete`
ranges, latest first, over the linked video and audio items, so the whole removal is
one undo entry. With
`dryRun: true` it returns the ranges (`{ startMs, endMs, kind, wordKeys }`) in its result
and writes nothing: no history entry, version unchanged. That list is the review list
the app and the agent show before applying.

Arguments (plan D-18). The exported zod schema of each op (`src/ops/`, one export per op,
`<opName>Args`) is the contract; the shapes below summarise it. Times are timeline ms,
except `inMs` (source ms).

- `addMedia { media }` (the caller picks `media.id`), `updateMedia { mediaId, patch }`
  (every field except `id` and `kind`; `null` clears an optional field), `removeMedia
  { mediaId }`, `replaceMedia { mediaId, withMediaId }` (reports `clamped` item ids).
- `addSequence { name, id?, canvas?, styleId? }` (default 1080×1920, 30/1, `base`; reports
  `sequenceId`), `updateSequence { sequenceId, name?, canvas?, styleId?, sfx?, overlays?,
  sourceRange? }` (`null` clears `overlays`/`sourceRange`), `duplicateSequence
  { sequenceId, name? }` (new ids, link groups kept; reports `sequenceId`),
  `removeSequence { sequenceId }`.
- `addTrack { sequenceId, kind: 'video' | 'audio', name? }` (next free `V<n>`/`A<n>`, on
  top), `updateTrack { sequenceId, trackId, name?, locked?, hidden?, muted?, syncLock?, duck? }`,
  `removeTrack { sequenceId, trackId }` (empty tracks only, else `TRACK_NOT_EMPTY`),
  `reorderTracks { sequenceId, kind, trackIds }` (a permutation).
- `placeClip { sequenceId, trackId, mediaId, startMs, inMs = 0, durationMs?, withAudio?,
  audioTrackId = 'A1', onOverlap = 'error', frame?, motion?, volume?, fadeInMs?,
  fadeOutMs?, denoise? }`: `durationMs` defaults to the rest of the media and is required
  for images.
- `updateClip { sequenceId, itemId, frame?, motion?, volume?, fadeInMs?, fadeOutMs?,
  denoise? }` (plan D-18): a media clip's own settings (inspector sliders; `null` clears).
- `addScene { sequenceId, trackId, startMs, durationMs?, template, variables, sfxOff?,
  onOverlap }` (duration defaults to the template's), `updateScene { sequenceId, itemId,
  template?, variables?, sfxOff? }` (`variables` replaces the object; reports
  `droppedVariables` on a template switch).
- `moveItem { sequenceId, itemId, startMs?, trackId?, onOverlap, unlinked? }` (linked
  items move by the same time delta and stay on their tracks), `trimItem { sequenceId,
  itemId, edge: 'start' | 'end', toMs, unlinked? }`, `splitItem { sequenceId, itemId, atMs,
  unlinked? }` (the right parts get new ids and one new shared `linkId`), `removeItem
  { sequenceId, itemId, unlinked? }`.
- `rippleDelete { sequenceId, trackId, startMs, endMs }`: cuts the range on the track,
  every sync-locked track and the tracks of items linked to a cut item, and closes the
  gap. A media clip across a range edge is trimmed (or split around the range); a scene is
  shortened.
- `link { sequenceId, itemIds }` (two or more, new `linkId`), `unlink { sequenceId,
  itemIds }`, `setTransition { sequenceId, itemId, transition: { template, durationMs } |
  null }`.
- `setCaptions { sequenceId, enabled?, sourceTrackIds?, preset?, maxWords?, maxLines?,
  maxCharsPerLine?, gapFillMs?, autoEmphasis?, position?, overrides?, resetWords? }`: the
  first call creates the track (`enabled: true`, `sourceTrackIds: ['A1']`, preset
  `base/plain`, `position.yPct` 75 until the preset supplies it, other defaults as in
  "Schema"); `overrides` upserts by `wordKey` and merges the given fields; `resetWords`
  removes overrides; overrides whose `transcriptRev` no longer matches are dropped.
- `removePauses`, `removeWords` as above; they report `ranges`, dry run or not.
- `setClipSpeed { sequenceId, itemId, speed, unlinked?, onOverlap = 'error' | 'ripple' }` as in
  "Clip speed" (v1.1).
- `pasteItems { sequenceId, atMs, items: { trackId, item }[], trackMap?, onOverlap }`: the
  earliest item lands at `atMs`; ids and `linkId`s are new.
- `restoreSnapshot { name }`; `batch { ops: { op, args }[] }` (no nested `batch`, no
  `dryRun` inside).

`onOverlap: 'overwrite'` trims, splits or removes the items under the new range on the
target track only (their linked items are left alone). `'insert'` first splits items
that span `startMs` on the target tracks and every sync-locked track, then shifts every
item at or after `startMs` on those tracks by the new duration.

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
- Times are snapped to the frame grid before validation (`inMs` to the source grid, see
  "Time and the frame grid").

## History

### Change records

Undo does not use Immer array patches (their index paths break once anything else
edits the array). Instead, the project is viewed as a map of entities addressed by
stable keys:

| Key | Entity |
|---|---|
| `project` | id, name, meta without `updatedAt` (stamped on every write, never undone; plan D-18) |
| `media:<mediaId>` | a MediaItem |
| `sequence:<seqId>` | sequence fields + ordered track ids |
| `track:<seqId>/<trackId>` | track fields (no items) |
| `item:<seqId>/<itemId>` | an item plus its `trackId` |
| `captions:<seqId>` | the CaptionTrack's own fields (no overrides) |
| `captionOverride:<seqId>/<wordKey>` | one caption override (plan D-15) |

`normalise(project) → Map<key, entity>` and `denormalise(map) → project` convert both
ways (items re-sorted by `startMs`, caption overrides by `wordKey`). After an op runs,
the engine diffs the normalised before/after views and records only changed entities:

```ts
HistoryEntry {
  version: number            // project version after this entry
  ts: string
  kind: 'op' | 'undo' | 'redo'
  actor: 'user' | 'agent' | 'cli' | 'external'
  runId?: string             // agent run that produced it
  jobId?: string             // job whose result it applied (plan D-15)
  op?: string; args?: unknown           // for 'op'
  coalesceKey?: string       // see "Coalescing"
  replaces?: number          // the coalesced entry this one replaces
  targets?: number[]         // for 'undo'/'redo': the versions being undone/redone
                             // (one for a normal undo, several for undoRun)
  changes: { key: string; before: Entity | null; after: Entity | null }[]
}
```

`before: null` = created, `after: null` = deleted. The set of keys is the entry's
touched set.

A history line may carry fields this engine does not know (a newer engine wrote them);
they are kept. A line is invalid when an `op` entry has no `op` or an `undo`/`redo`
entry has no `targets` (plan D-28).

Because overrides are separate entities, `undoRun` conflicts on captions are per word:
a user's edit of one word no longer conflicts with an agent's edit of another.

### Coalescing (plan D-15)

Sliders and typing send many small ops. `applyOp(..., { coalesceKey })` merges them into
one undo step. A new `op` entry coalesces with the previous entry when that entry is the
newest in the log, is an `op`, and has the same `coalesceKey`, `actor` and `runId`, and
when it is less than 1 s old. The log stays append-only: the new entry gets the next
version and `replaces` the previous one. Its `after` values are the new ones; for each
key the previous entry touched, its `before` is the previous entry's `before`. The undo
cursor drops the replaced entry, so one undo reverts the whole gesture.

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
`undoRun(projectId, runId, { last: true })` does the same for the run's newest un-undone
entry only (the agent's `undo_my_last_edit`; plan D-43).

### Write order, crash recovery, locking

`applyOp(projectId, op, { actor, runId?, baseVersion?, coalesceKey?, jobId? }) → ApplyResult`:

```ts
ApplyResult {
  version: number
  changes: { key: string; before: Entity | null; after: Entity | null }[]
  results: { op: string; status: 'succeeded' | 'failed' | 'conflicted'
             error?: VoxErrorJson                   // plain { code, message, hint, details? } (D-28)
             items?: Item[]                         // touched items' new state,
                                                    // each with its trackId
             report?: unknown }[]  // op output, e.g. removePauses ranges (plan D-18)
}
```

`results` has one entry per op: one for a single op, one per op inside a `batch`
(plan D-15). An op rejected by validation is `failed`; one rejected because the project
moved on (`STALE`, `JOB_CONFLICT`) is `conflicted`; each carries its error (`VoxErrorJson`). A batch
stays all or nothing: when any op is rejected, nothing is applied, `version` is
unchanged, `changes` is empty, and the other ops are `failed` with no error of their
own. Lock and file errors (`LOCKED`, `HISTORY_CORRUPT`) still throw.

Steps:

1. Take the cross-process lock: create `project.lock` exclusively (a fully written temp
   file hard-linked into place, which fails like `O_EXCL`; plan D-28), containing
   `{ pid, host, startedAt, nonce }`. If it exists, was written by this host, and its pid is
   dead (or it is older than 60 s), remove it (one breaker at a time, only if unchanged)
   and retry; otherwise wait up to 5 s, then
   fail `LOCKED`. A lock from another host is never broken automatically (projects on
   shared drives are not supported; `vox doctor <project> --unlock` removes it).
2. If `project.json`'s on-disk version differs from the cached one (another process
   wrote), reload and emit `project.changed` with `actor: 'external'`.
   `getProject`, `view` and `history` make the same check when they read (plan D-28).
3. If `baseVersion` is given and differs from `project.version`, fail `STALE`.
   A job result (`jobId` set) instead fails `JOB_CONFLICT` only when an entry after the
   job's `baseVersion` touched a key the result touches (see "Library API").
4. Run the op and compute `changes`; apply coalescing (see "Coalescing").
5. Append the history line and `fsync` the file.
6. Write `project.json` to a temp file, `fsync` it, rename over the old file, `fsync`
   the directory.
7. Release the lock and emit `project.changed { projectId, version, actor, runId, op,
   changes }`.

On load, before anything else:

- If `project.json`'s `schemaVersion` is newer than this engine supports, the load fails
  with `SCHEMA_TOO_NEW` (hint: update Vox Studio) and writes nothing: no lock, no
  recovery, no migration, no log line in the project (plan D-15).
- Before a load-time migration from `schemaVersion` N, the engine copies `project.json`
  to `snapshots/auto-pre-migrate-v<N>.json`; then it migrates.
- A last history line that is unterminated or not JSON (torn write) is truncated; a
  complete line that fails the schema is `HISTORY_CORRUPT`.
- If the last entry's `version` is `project.version + 1`, its `after` values are
  applied (a coalesced entry after the replaced entry's `before` values; plan D-28) and
  `project.json` is rewritten (the crash happened between steps 5 and 6).
  The recovered entry keeps its own version; recovery adds no history line and does not
  bump the version; it only logs a line to `logs/engine.log`.
- Any other gap fails with `HISTORY_CORRUPT` and a hint to restore from `snapshots/`.

`history.jsonl` rotates at 5,000 entries: all but the newest 500 move into
`history/<firstVersion>.jsonl.gz`, so undo works across a rotation (plan D-18);
rotation also writes `history/snapshot-<version>.json`.

The desktop app (spec 4) also watches `project.json` so that a `vox op` from a terminal
shows up in the open editor.

### Snapshots

`snapshot(projectId, name)` copies `project.json` to `snapshots/<name>.json`.
`restoreSnapshot` is an op, so restoring is undoable.

## Compile: sequence → HyperFrames

`compile(projectId, sequenceId, { mode: 'preview' | 'render', range?, captions? }) → BuildResult`
(`captions: false` leaves out the caption layer; plan D-32)
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
  (`data-start`, `data-duration`, `data-media-start`, and `data-playback-rate` for a clip
  with `speed`, see "Clip speed"). `preview` uses proxies; `render`
  uses originals, or the CFR copy (`cfrPath`) for a VFR video (plan D-15). `facetrack`,
  `auto` and `manual` keyframes (see "Shots and framing") become GSAP keyframes on a CSS
  `transform` (translate + scale), not `object-position`, so the crop can zoom; image
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
  HTML. Compile passes the `CaptionChunk[]` (word times and emphasis) to the preset
  through `vox.vars(el)`. Compile, not the preset, applies the preset's `case` and
  `stripPunctuation` to the word text first (plan D-15).
- Entrance skip (plan D-15): when a scene's template sets `minEntranceMs` (spec 2) and
  the item's duration is below it, compile injects the reserved variable
  `skipEntrance: true` into that scene's variables, and the template skips its entrance
  animation.
- Preview audio: each audio-track clip becomes a timed `<audio>` element using
  `audio/<mediaId>.m4a` with static volume (`data-volume`), so the player has sound.
  Fades are approximated with a GSAP volume tween if the spike confirms it works;
  otherwise preview plays without fades. Muted tracks are skipped.
- SFX: if `sequence.sfx` is true, the sequence's cue list (see "Sound cues") becomes
  timed `<audio>` elements in preview.
- Referenced files are hard-linked (or copied across devices) into the build folder.

Compile is deterministic: the same project and version produce byte-identical output.

### Audio

Final audio never goes through HyperFrames. `src/audio/` builds one ffmpeg filter graph
from the model: every audio-track clip (`atrim` at `inMs`, `afftdn` when `denoise` is
not `off`, `atempo` with a preroll for a clip with `speed` (see "Clip speed"), a gain-to-target, `adelay` to `startMs`, `volume`, `afade` for fades), SFX
cues, track mutes, then `amix` with normalisation off and a limiter, then `loudnorm`
(two-pass) to the export loudness target integrated and −1.5 dBTP true peak (0.5 dB under
the audio QA ceiling of −1 dBTP, plan D-32).

Per-source level (plan D-15): each clip whose media has `loudness` gets a gain of
(target − `integratedLufs`) dB before `amix`, so sources recorded at different levels
match; the final two-pass `loudnorm` stays. `denoise: 'light' | 'strong'` maps to two
fixed `afftdn` strengths (ffmpeg built in; no RNNoise model files in v1).

The export loudness target is a preset: `youtube` = −14 LUFS (default), `tiktok` =
−12 LUFS, `broadcast` = −23 LUFS (`render --loudness`).
`render` renders the picture with HyperFrames (silent) and muxes it with
this mix. Audio and picture are both placed from the same frame-grid times, so sync
does not depend on the browser.
Ducking (v1.1, plan D-61): an audio track with `duck: true` that is not a captions source has its clips
mixed into one bus, which `sidechaincompress` lowers while the speech bus (the captions source tracks,
after their gain-to-target, volume and fades) is loud. This sits after each clip's gain-to-target and
before the final `amix`; speech and SFX are never ducked, and with no speech clip the flag does nothing.
The same graph can write three stems (speech = audio tracks with captions sources,
other audio tracks, SFX) as WAV for the audio QA; stems skip `loudnorm`.

### Sound cues (plan D-14)

Sound effects are placed from events on the timeline, never typed by hand as frame
numbers. Compile writes the cue list to `build/<sequenceId>/audio/cues.json`:

```ts
Cue { atMs: number; sfx: string; type: 'cut' | 'move' | 'land' | 'appear' | 'hero'
      itemId: string; cueName: string }
CueList { cues: Cue[]; dropped: { cue: Cue; reason: 'spacing' | 'hero-spacing' | 'muted' }[] }
```

- Sources: each scene's and each transition's template `sfxCues` (spec 2: `atMs`
  relative to the item's start, or `'entrance'`; each cue has a `type`), placed at the
  item's start plus the offset and snapped to the frame grid. A cue named in the item's
  `sfxOff` is dropped as `muted`; `sequence.sfx: false` drops all.
- Types follow what happens on screen: `cut` = full-frame change, `move` = frame of peak
  motion, `land` = frame where motion stops, `appear` = an element pops in, `hero` = the
  one big moment of a scene (a logo, a reveal).
- Spacing: a cue closer than 120 ms to an earlier kept cue is dropped (`spacing`); a
  `hero` cue within 4,000 ms of an earlier kept `hero` is dropped (`hero-spacing`).
  Drops are listed, never silent.
- Templates are checked for cue timing by measurement (spec 2 "Testing"), so a cue's
  `atMs` matches the template's own animation.

### Audio QA (plan D-14)

The engine cannot hear, so it measures. `vox audio-qa <project> [--seq id] [--loudness preset]` (job kind
`audioQa`, Python tool `vox_py.audioqa`, numpy only, audio read as PCM through ffmpeg)
renders the stems and the final mix (no picture) and checks:

| Check | Pass rule |
|---|---|
| cue timing | each kept cue has an SFX-stem onset within 1 frame of its `atMs` |
| one event per cue | no second onset inside a cue's sample (two events in one clip) |
| spacing | no two SFX-stem onsets closer than 120 ms |
| SFX under speech | while speech is active, SFX short-term loudness is ≥ 6 LU below speech |
| loudness | final mix at the chosen target ±1 LU integrated (default `youtube`, −14 LUFS); true peak ≤ −1 dBTP; no clipped samples |

It writes `renders/qa/<sequenceId>/qa.json` (each check with its numbers and
pass/fail), `qa.png` (stem and mix waveforms with a numbered marker per cue, drawn with
numpy and written as a PNG because the ffmpeg on the M5 has no `drawtext`; `qa.json` maps each
number to its cue; plan D-27, so a vision model can look at it) and
`LISTEN.md`: five timecodes for a human ear check (hero cues first, then the loudest SFX
moments, then the largest speech/SFX overlaps), each with what to listen for. The
thresholds live in `py/vox_py/audioqa_thresholds.json`; changing one needs a plan
DECISIONS entry, and a threshold is never loosened to make a check pass. The file
stores the loudness tolerance (±1 LU), not the target; the target comes from the
`--loudness` preset (plan D-15), which is not a loosening. The QA reports
numbers; it never states that the sound is good, because only a person can judge that.

`vox audio-qa --kit <styleId>` checks a style's SFX files instead (spec 2 "SFX rules")
and writes `qa/kit-<styleId>.png`, one waveform and spectrogram per file.

### Layer renderer (shared)

`renderLayers(projectId, sequenceId, layers)` renders chosen layers (a scene, a
transition, the captions, overlays) to ProRes 4444 MOV with alpha using
`hyperframes render --format mov`. It is used by:

- `export-timeline`, which needs scene and caption layers as MOVs;
- the hybrid export, if the spike fails: originals are composited with ffmpeg
  `overlay` in the same bottom-to-top order compile uses, then muxed with the audio
  mix. In that case preview (player) and export differ in implementation, and the
  spec's Goal 3 holds only visually; the integration test compares sampled frames of
  both within a tolerance;
- the preview pre-render cache, if enabled (below).

**Pre-render cache** (plan D-15, conditional): it is built only if the spike's preview
fps margin on heavy scenes is under 20% (item 4). The app then renders scene instances
in the background with `renderLayers` into `cache/prerender/<hash>.mp4`, keyed by the
hash of the instance file, and the player mounts the cached clip instead of the live
scene. A changed instance file gets a new hash, so a stale clip is never shown.

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
- audio on `A1` linked to the cuts;
- a VFR phone-style clip (variable frame durations, its own burnt-in frame counter) on
  `V1`, rendered through its CFR copy (plan D-15).

Pass bar (all must hold, measured on the M5):

1. **Cut accuracy**: at every cut, the rendered frame before and after the cut matches
   the ffmpeg-extracted reference frame (frame counter OCR or pixel diff); no ±1-frame
   error, no grey or black frames. This includes the cuts on the VFR clip.
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
   The spike also records the **fps margin on heavy scenes** (plan D-15): the lowest
   fps over any 1 s window while the `stack` scene and the video-slot scene play,
   as a percentage above 24 fps. It is recorded even when item 4 passes.
5. **Memory**: peak RSS of the render under 12 GB.
6. **Op → preview latency**: one `trimItem` → in-memory compile → player update in
   < 1 s; the spike tries a scene-only patch path (replace one instance file and
   remount) and a full reload, and records both.
7. **Mechanisms**: per-instance `data-vox-vars` injection with 8 scenes mounted at once
   (`vox.vars(el)` returns each scene's own data), scoped token styles, muted video with
   separate `<audio>`, and GSAP volume tweens either work or are recorded as not
   working.
8. **Fillers** (recorded, not a pass condition; plan D-15): on a speech fixture that
   contains "um" and "uh", transcribe with and without the filler `initial_prompt`
   and record how many fillers survive in each.
9. **NTSC rate** (plan D-15): the fixture is also rendered as a 30000/1001 sequence
   (a 29.97 fps source on `V1`). Cut accuracy (item 1) and A/V sync (item 2) must hold.
   If HyperFrames cannot render a fractional rate frame-exactly, GATE 1 records it,
   `canvas.fps` keeps only the integer rates, and NTSC sources conform to the nearest
   integer rate (the CFR copy is made at that rate).

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
- Item 4 passes but its fps margin on heavy scenes is under 20% → the pre-render cache
  (see "Layer renderer") is built. GATE 1 records the margin.

The pinned HyperFrames version and the measured numbers are written into this spec.

**Measured (GATE 1, phase 01, 2026-10-11, D-29):** HyperFrames 0.8.145, GSAP 3.15.0, Electron
44.7.0 (Chromium 152). All nine items pass, so HyperFrames renders whole sequences, the preview
keeps the opaque sandbox, NTSC goes ahead, and no pre-render cache is built. Numbers: cuts 0
mismatches over 43 cuts; A/V max 0.35 ms; render 0.67× real time (60.5 s); preview min 26.4 fps,
max stall 83 ms, seek to a cut max 53 ms with 0 wrong frames, audio and picture within 1 frame
(p95 0 ms and 23.8 ms after seeks); peak RSS 2.07 GB; op → preview 31 ms by scene-only patch,
757 ms by full reload; all four mechanisms work in render and preview; NTSC 0 mismatches, A/V max
0.4 ms; heavy-scene fps margin 20.8 % (29 fps); fillers: um and uh both survive with and
without the filler prompt. Preview builds need the helpers in `spike/templates/vox-preview.js`
(+1 ms video bias, pre-cue, paused exact-frame sync, playhead after mount, inactive videos kept
composited). Details and evidence: `docs/SPIKE_RESULTS.md`.

## Stages

Every stage is idempotent: outputs are keyed by a hash of their inputs under `cache/`,
and a rerun with unchanged inputs is a no-op. Stages run as jobs (below).

| CLI | Does |
|---|---|
| `vox doctor` | checks ffmpeg, ffprobe, yt-dlp (+ `yt-dlp-ejs` and deno or node, offers `yt-dlp -U`; reports whether `--impersonate` targets exist, which some TikTok pages need), uv env, Chromium for HyperFrames, pinned HyperFrames version, model downloads and their licences; prints fixes |
| `vox paths [--json]` | prints the resolved projects folder, styles folders and tool paths (see "Project folder") |
| `vox quick <url\|path> [--count 3] [--length 30-60] [--name n] [--render] [--out-dir dir]` | quick clips (below): new project, then the chain ingest → shots → transcribe → facetrack → quickClips, `count` captioned 9:16 clips with no style beats and no AI key needed; `--render` also writes MP4 (subtitles burned in) + SRT per clip, into `--out-dir` when given (see "Export targets"), else the project's `renders/` |
| `vox new <name>` | creates a project with one empty 9:16 sequence; `styleId` is `vox` if installed, else `base` |
| `vox ingest <project> <url\|path>... [--playlist]` | download (YouTube, Instagram, TikTok or any yt-dlp URL; see "Ingest sources") or copy a local file; content-sniffed type; ffprobe metadata; source fps, VFR check and CFR copy, loudness (see "Ingest analysis"); proxy, extracted audio, thumbs, peaks; `addMedia`. Text files (`.txt`, `.md`, `.fountain`, `.pdf`) become `document` media with plain text at `media/<id>.txt` (`.pdf` text via `pypdf`, BSD, in `py/`). `--no-proxies` (API `{ proxies: false }`) skips proxy, thumbs and peaks; styles Part C uses it for reference videos |
| `vox transcribe <project> [mediaId...]` | Silero VAD speech gate, then mlx-whisper (pinned repo) with a filler `initial_prompt`, auto language, word timestamps; drops non-speech; computes word kinds (see "Speech gate") |
| `vox shots <project> <mediaId>` | shot detection with ffmpeg `scdet` on the proxy (else the original, scaled) → `shots/<mediaId>.json` (see "Shots and framing") |
| `vox facetrack <project> <mediaId>` | MediaPipe Tasks `FaceDetector` (full-range model, downloaded `.tflite`) plus Apple Vision body and saliency, at 12 fps on the proxy scaled to 360p; per-shot subject choice with hysteresis (`faceIndex` overrides) → `{ atMs, x, y, scale }` crop keyframes (see "Shots and framing") |
| `vox assets search <project> "<query>" [--source commons,openverse]` | candidates with licence + author, stored in `cache/assets/<queryHash>.json`; the job result returns them |
| `vox assets fetch <project> <candidateId>` | download, record licence, `addMedia` (origin `archive`) |
| `vox assets cutout <project> <mediaId>` | rembg (pinned permissive model) → transparent PNG as a new media item; refused for no-derivatives licences |
| `vox assets generate <project> "<prompt>" [--style id] [--provider id]` | image from a registered `ImageProvider` → new media item (origin `generated`); fails with a hint when none is registered |
| `vox op <project> <opName> '<json>' [--actor user\|agent\|cli] [--run-id id] [--base-version n] [--coalesce-key k]` | apply an edit operation |
| `vox undo <project> [--run <runId>]` / `vox redo <project>` / `vox history <project> [--since <version>]` | history (`--run`: `undoRun`) |
| `vox snapshot <project> <name>` / `vox snapshot <project> --list` | named snapshot; list them |
| `vox compile <project> [--seq id] [--mode preview\|render]` | writes `build/` |
| `vox preview <project> [--seq id]` | compile + `npx hyperframes play` |
| `vox frames <project> [--seq id] --at-ms 1200,5000` | still PNGs of the compiled sequence at canvas size |
| `vox media-frames <project> <mediaId> --at-ms 1200,5000` | source stills via ffmpeg (agent footage tagging) |
| `vox render <project> [--seq id \| --all] [--range-ms a-b] [--quality draft\|standard\|high] [--captions burn\|none] [--loudness youtube\|tiktok\|broadcast] [-o file \| --out-dir dir] [--overwrite]` | final MP4 (quality passed explicitly; HyperFrames' own default is `looks`); `--captions none` renders without subtitles (default `burn` when captions are enabled); `--loudness` sets the mix target (default `youtube`, see "Audio"); target per "Export targets" |
| `vox audio-qa <project> [--seq id] [--loudness youtube\|tiktok\|broadcast] [--kit styleId]` | audio QA (see "Audio QA") against the chosen loudness target; prints the check table and the five listen timecodes |
| `vox export-captions <project> [--seq id] --format srt\|vtt [-o file \| --out-dir dir]` | caption file from `deriveCaptions` |
| `vox export-timeline <project> [--seq id] [-o file \| --out-dir dir]` | `.otio` timeline referencing originals + layer MOVs (Resolve 18.5+ reportedly imports OTIO natively; secondary sources only, so done-when #5 is the gate, including alpha on the MOV layers) |
| `vox credits <project>` | licence/attribution list for archive assets used |

`<project>` in every command is the project id, or a project name that matches exactly
one project; an ambiguous name fails and lists the matching ids.

### Ingest analysis (plan D-15)

- **Frame rate**: ingest stores the video's rate from ffprobe `r_frame_rate` as
  `MediaItem.fps` (any rate; only `canvas.fps` is limited to the fixed set).
- **VFR**: a video is variable frame rate when `r_frame_rate` ≠ `avg_frame_rate`, or when
  its pts deltas spread over more than 1 frame. A VFR video gets a constant-frame-rate
  copy `media/<id>.cfr.mp4` (`cfrPath`, `vfr: true`) at the rate of the fixed set nearest
  its average rate (libx264 `-crf 18`, audio copied); `fps` is that rate. The proxy is
  made from the copy, and render uses it instead of the original, because Chromium
  seeking on a VFR file lands on a neighbouring frame.
- **Loudness**: each audio-bearing source is measured with ffmpeg `ebur128` (true peak
  on) into `MediaItem.loudness { integratedLufs, truePeakDb }`, for the per-clip gain in
  "Audio".

### Speech gate and word kinds (plan D-15)

`transcribe` runs Silero VAD first (`vox_py.vad`). The ONNX model is vendored at
`py/vox_py/models/silero_vad.onnx` (MIT, SHA-256 checked on load) and runs through
`onnxruntime`, so nothing is downloaded at run time and torch is not needed. Then:

- Whisper gets an `initial_prompt` built from the English filler list, so it keeps more
  fillers (the spike records how many survive).
- Each word is clipped to the speech region it overlaps most; a word that overlaps no
  region by at least 40 ms (or its whole length, if shorter) is dropped (D-21). Whisper segments
  with `no_speech_prob > 0.6` or `compression_ratio > 2.4` are dropped whole. This stops
  invented text over music and silence.
- The engine computes word kinds and pause pseudo-words (see "Transcripts"), writes
  `transcripts/<mediaId>.json` with `speechRegions`, and updates `transcriptRev`.

### Shots and framing (plan D-15)

**Shots.** `src/stages/shots.ts` runs ffmpeg `scdet` (threshold 10, about `scene > 0.35`)
on the proxy (or, when the media has no proxy, on the original scaled to 360p in the
same ffmpeg filter graph) and writes `shots/<mediaId>.json` = `{ startMs, endMs }[]`, covering the
whole media, then sets `shotsPath`. Job kind `shots`. `vox quick` and the clipper run it
after ingest. TransNetV2 (MIT) is the documented fallback if the fixture test misses
cuts; it is not built in v1.

**Detection.** `vox_py.facetrack` samples at 12 fps on the proxy scaled to a 360 px short side (D-21; the original
when there is no proxy). Each
sample holds the faces (MediaPipe), and the body boxes (Vision
`VNDetectHumanRectanglesRequest`) and attention saliency box (Vision
`VNGenerateAttentionBasedSaliencyImageRequest`). It writes `facetracks/<mediaId>.json`,
once per media.

**Path.** The engine turns the detections into crop keyframes `{ atMs, x, y, scale }`:

- Smoothing resets at every shot boundary (from `shots/<mediaId>.json`), so the crop
  jumps to the new shot's subject at the cut and never drifts across it.
- Subject per shot: `facetrack` uses faces only, else the centre. `auto` falls back
  from face to body to saliency to the centre. `faceIndex` pins one face.
- The first subject in each shot is the largest face, unless `faceIndex` pins one;
  hysteresis then keeps it.
- Hysteresis: the path keeps the current face unless another face is more than 30%
  larger for at least 1 s, so two podcast guests do not flap.
- `stability`: `locked` gives one static crop per shot when the subject stays inside a
  10% dead zone (a shot where it leaves is treated as `smooth`); `smooth` follows with
  smoothing; `follow` follows closely. `trackSpeed` (`slow`, `normal`, `fast`) sets how
  fast the crop may move.
- The path is cached under the key (media hash, aspect, mode, stability, trackSpeed),
  where aspect is the sequence canvas's.

**Keyframes on the clip.** `frame.keyframes` times are relative to the item start, so
moving an item keeps them and a trim of the start shifts them. In `manual` mode they are
the crop (without them, `x`, `y`, `scale` are a static crop). In `facetrack` and `auto`
mode each one is a user override: it pins the crop at that time, and the crop blends back
to the tracked path over 300 ms. Compile emits the result as a CSS `transform` (see
"Compile").

### Quick clips

The simple path (plan D-11): URL in, captioned clips out, no style work and no AI key.
`quickClips(projectId, mediaId, { count = 3, minMs = 30000, maxMs = 60000, scorer?, prompt? })`
runs as job kind `quickClips` at the end of the chain `ingest → shots → transcribe →
facetrack → quickClips`:

1. Split the transcript into sentence units at words ending a sentence (`.`, `?`, `!`
   and their equivalents) or at pauses ≥ 700 ms.
2. Candidates are runs of whole units whose length is within `[minMs, maxMs]`, so every
   clip starts and ends on a sentence boundary. Boundaries (plan D-15): a clip starts
   120 ms before its first word, but never inside the previous word. A start that falls
   within 2 frames before a shot cut moves to the cut. Pauses at the clip's edges are
   trimmed, so it ends at its last word's end.
3. Score each candidate. The built-in heuristic scorer uses speech ratio (time inside
   the transcript's `speechRegions` ÷ length) minus 0.5 per internal pause over 1.5 s.
   It adds three no-AI signals (plan D-15), each scaled to 0..1 and added with equal
   weight: energy (variance of short-term loudness over the candidate), hook (the first
   sentence is a question or holds a number) and coverage (share of the candidate with a
   face on screen, from facetrack). Ties go to the earlier start. A
   registered scorer (`engine.quickClips.registerScorer(id, fn)`; the agent registers an
   LLM scorer when a `fast` model exists, spec 3) gets each candidate's text and times,
   plus `prompt` (e.g. "moments about pricing"), and returns a score per candidate; the
   heuristic ignores `prompt` and is the fallback when the scorer fails.
   `scorer` omitted → the most recently registered scorer, else the heuristic;
   `scorer: 'heuristic'` forces the built-in one.
4. Pick the top `count` candidates that do not overlap. Fewer fitting candidates means
   fewer clips, reported in the result.
5. Each pick becomes a sequence in one `batch`: name "Clip <n>", 1080×1920 at the
   source's rate when it is in the fixed set, else the nearest rate in the set,
   `styleId: 'base'`, `sourceRange` set, the range
   placed once as a linked pair (`V1` with `auto` framing, which falls back from face
   to body to saliency to the centre (plan D-15); `A1` speech), captions on (`sourceTrackIds: ['A1']`, preset
   `base/plain`, `maxWords` 3). No scenes, transitions or overlays.

The result lists the sequence ids, the chosen ranges with their text, and the scorer
used. Selection is deterministic for the same transcript, options and scorer output.
The `batch` carries the job's `jobId`, so "Undo quick clips" is one history entry. When
Stylize or the clipper later add transitions at clip edges, they default to cover-style
ones (see "Transitions").
Styling is a separate, optional step (spec 3 "Stylize"; or by hand in the app).

Encoding: ffmpeg comes from Homebrew (plan D-05), whose build includes libx264. Proxies
use libx264 at 540p with `-crf 23` and a keyframe every 0.5 s (`-g` and `-keyint_min` set
from the source fps). `render` muxes HyperFrames' H.264 output with the audio mix using
`-c:v copy` and AAC audio, so the picture is encoded only once.

### Export targets (plan D-13)

Every export (`render`, `exportCaptions`, `exportTimeline`) takes an optional target:
`{ file: absPath }` or `{ dir: absPath }`. Without one it writes to the project's
`renders/` with an engine-generated name `<project>-<sequence>[-<n>].<ext>`.

- Only trusted callers pass a target: the CLI (`-o`, `--out-dir`) and the desktop app's
  engine host, which passes only a path the user picked in a native dialog this session
  (spec 4). The agent has no export tool and no path argument (spec 3).
- The target must be absolute; its folder must exist and be writable (else
  `EXPORT_PATH` with a hint). It may be anywhere the user can write, including outside
  the projects folder.
- The file is written as a temp file in the target folder, then renamed, so a failed
  export never leaves a half file. An existing file is replaced only with `--overwrite`
  (CLI) or after the native save dialog's own "Replace?" confirmation (app); in folder
  mode the engine never replaces a file and adds ` (2)`, ` (3)` … instead.
- `--all` / batch writes one file per sequence into the folder.
- An `.otio` written outside the project references the project's media by absolute
  path and puts its layer MOVs in a folder `<name>-layers/` beside it.
- The job result lists every written path; the app records them for "Reveal in Finder".

### Ingest sources (plan D-13)

- **Links**: any `http(s)` URL that yt-dlp supports. YouTube (watch, `youtu.be`,
  Shorts), Instagram (reel, post, IGTV) and TikTok (video page and `vm.`/`vt.` short
  links) are named in the UI and tested; `src/stages/sources.ts` classifies a URL as
  `youtube | instagram | tiktok | other` for the UI badge and error hints only; the
  download path is the same yt-dlp path for all.
- **Files**: a video, audio or image file the user already has (chosen in a dialog,
  dragged in, or given to the CLI), or a folder of them. Containers are detected from
  content: MP4/MOV/M4V, WebM, MKV for video; the copy goes to `media/`.
- **Login walls**: public posts need no account. When yt-dlp reports that a post needs a
  login, is private or is rate-limited, ingest fails with `LOGIN_REQUIRED` and the hint
  "This post needs a login. Download the video yourself and drop the file here, or turn
  on 'Use browser cookies' in Settings." The opt-in setting `ingest.cookiesFromBrowser`
  (`'safari' | 'chrome' | 'firefox' | null`, default `null`, in `~/.vox/config.json`)
  adds `--cookies-from-browser <browser>`. It is set only by the user (Settings or
  `vox config set`), never by a URL, a project file or the agent, and its value is
  shown with a note that yt-dlp then sends that browser's login cookies to the site.
- **Multi-video posts** (Instagram carousels, playlists): only the first video is taken
  (`--playlist-items 1`) and the result says how many there were; `--playlist` takes all.

### Ingest hardening

- URLs: only `http(s)`. yt-dlp does its own DNS and follows redirects, so a pre-check
  of the host is not enough. Instead, every yt-dlp network connection goes through a
  small local filtering proxy started by the engine (`--proxy http://127.0.0.1:<port>`).
  The proxy resolves each `CONNECT`/request host itself and refuses private, loopback,
  link-local and multicast addresses, connecting to the IP it checked (no DNS-rebinding
  window). Archive and image downloads by the engine use the same check in-process.
- yt-dlp runs with `--ignore-config --no-plugin-dirs --no-playlist --playlist-items 1
  --max-filesize 4G -f "bv*+ba/b" -S "res:1080" --merge-output-format mp4`
  (`--playlist` opt-in removes `--no-playlist` and `--playlist-items 1`), output to an
  engine-generated name, never the remote title. `-S "res:1080"` limits the smaller side,
  so vertical 1080×1920 reels and TikToks keep full quality (a `height<=1080` filter
  would drop them).
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
  applyOp(projectId, op, opts) → ApplyResult   // { version, changes, results }; see "Write order"
  view(projectId, sequenceId) → SequenceView   // compact read for the agent (plan D-15)
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
    start(kind, args) → jobId   // ingest | transcribe | shots | facetrack | quickClips | assets.search |
                                // assets.fetch | assets.cutout | assets.generate |
                                // render | frames | exportCaptions | exportTimeline |
                                // audioQa
    register(kind, handler)     // other packages add kinds, e.g. agent's style.extract
    get(jobId) → { status, progress, result?, error? }
    cancel(jobId), list(projectId)
  }
  on(event, handler)   // 'project.changed' | 'job.started' | 'job.progress' |
                       // 'job.done' | 'job.failed' | 'job.cancelled'
}

SequenceView {
  version: number
  items: { id: string; track: string; startMs: number; endMs: number
           kind: 'video' | 'audio' | 'image' | 'scene'
           mediaId?: string                 // media clips
           template?: string; text?: string // scenes; text = first string variable, if any
         }[]
  captions: { startMs: number; endMs: number; text: string }[]   // chunk text
}
```

Job args include `quickClips { mediaId, count?, minMs?, maxMs?, scorer?, prompt? }` and
`render { ..., loudness?: 'youtube' | 'tiktok' | 'broadcast' }` (default `youtube`).

**Compact view** (plan D-15). `view` returns a flat, token-cheap read of one sequence.
The agent reads this, not the full project (spec 3).

**Job results** (plan D-15). A job that writes to the model (ingest, transcribe, shots,
facetrack, quickClips, assets fetch/cutout/generate) records the project `version` as its
`baseVersion` when it starts. At the end it applies its result as one `batch` with its
`jobId` on the history entry (the job args' `actor`, default `user`; an agent run also passes its
`runId`, which the entry carries, so `undoRun` undoes the job's result with the run; plan D-50). If an entry after `baseVersion`
touched any key the batch touches, the job fails with `JOB_CONFLICT`, listing those keys,
and overwrites nothing. A job's result is therefore one undo entry.

**Config.** `src/config.ts` is the only code that reads or writes `~/.vox/config.json`;
the engine, agent, CLI and app all go through it. It owns the zod schema (the provider,
role and limit sections are defined in spec 3; `contact`, `projectsDir` and
`ingest.cookiesFromBrowser` are defined here), writes with
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

- All failures raise `VoxError { code, message, hint, cause?, details? }` (`details`:
  structured data such as conflicting keys and item ids; plan D-18). The CLI prints
  `hint`; `--json` prints the object. Exit code 1.
- External tool failures (yt-dlp, ffmpeg, Python, HyperFrames) capture the last 40
  lines of stderr into `cause`, after passing it through the engine's redactor
  (`engine.redactor`, see "Library API").
- Network stages retry 3× with backoff. If an archive search returns nothing, the
  stage says so; it never silently substitutes generated images (the agent decides).
- `ingest` accepts a local path when yt-dlp fails; the error hint says so.
- `LOGIN_REQUIRED` (login-walled, private or rate-limited post; see "Ingest sources") and
  `EXPORT_PATH` (export folder missing, not writable, or file exists without
  `--overwrite`) carry hints that name the next step.
- `SCHEMA_TOO_NEW` (the project was saved by a newer Vox Studio; nothing is written) and
  `JOB_CONFLICT` (a job's result touches entities changed since the job started; lists
  the keys) also carry hints (plan D-15).

## Testing

- **Unit (vitest)**:
  - every operation: overlap rules, insert/ripple across sync-locked tracks, linked
    items, trim/split math on the frame grid at every rate in the fixed set, including
    23.976/29.97/59.94 (no 1-frame gaps after 100 random splits), locked tracks,
    track-kind rules, batch atomicity, STALE, `removeMedia` leaving the file on disk;
  - frame rates (plan D-15): `frame(ms(f)) = f` for every frame of 10 hours at 30000/1001
    and the other rates; a 29.97 source in a 30 fps sequence keeps `inMs` on the source
    grid after trims and splits;
  - `removePauses` / `removeWords`: one undo entry that cuts linked video and audio
    together, `keepMs` kept, `kinds` with `filler` and `repeat`, `dryRun` returns the
    ranges and leaves version and history unchanged, `wordKeys` removes only the listed
    ranges and each still keeps `keepMs`;
  - write results: per-op `succeeded`/`failed`/`conflicted` in a `batch`, nothing applied
    when one op fails, `items` hold the new state;
  - history: normalise/denormalise round-trip, multi-level undo then redo returns the
    exact project, redo cleared by a new op, `undoRun` with and without conflicts;
    `undoRun` conflicts per caption word (`captionOverride` entities);
  - coalescing (plan D-15): ten slider ops with one `coalesceKey` within 1 s give one
    undo entry that restores the first `before`; a different key, actor or `runId`, an
    entry in between, or a gap over 1 s gives separate entries;
  - job results: a user edit to an entity a job writes makes the job fail
    `JOB_CONFLICT` and change nothing; an unrelated edit does not; "Undo quick clips" is
    one entry;
  - crash recovery: kill between history append and project write (both orders),
    torn last line, lockfile with a dead pid;
  - schema safety: a project with a newer `schemaVersion` fails `SCHEMA_TOO_NEW` and its
    folder is byte-identical afterwards (no lock, log or snapshot); a migration writes
    `snapshots/auto-pre-migrate-v<N>.json` first;
  - captions: trims, overrides (multi-word `text`, `text: null`, `startMs`/`endMs`,
    `emphasis`), `breakAfter`, re-transcription orphans, chunking, overlap priority,
    word clamping; lines by `maxCharsPerLine` and `maxLines`; gap fill (a 300 ms gap is
    filled, a 500 ms gap is not, with `gapFillMs` 400); word ends extended inside a chunk;
    `autoEmphasis`; no pause pseudo-words in captions;
  - transcripts: word kinds from fixture word lists (fillers, 1–3-word repeats, pauses
    ≥ 350 ms); words outside speech regions and segments over the `no_speech_prob` or
    `compression_ratio` limits dropped;
  - framing: no drift across a cut (the first keyframe after a shot boundary is on the
    new shot's subject); a two-face fixture does not switch subject unless the other face
    is > 30% larger for ≥ 1 s; a no-face shot uses saliency in `auto`; `locked` gives one
    crop per shot; keyframe overrides blend back over 300 ms and shift with a start trim;
  - audio: two sources measured 10 LU apart mix within 1 LU of each other; `denoise` and
    each `--loudness` preset appear in the graph snapshot; audio QA uses the chosen
    target;
  - quick clips: sentence-bounded ranges within `[minMs, maxMs]`, no overlaps,
    deterministic picks, scorer fallback, sequence shape (plan D-11); 120 ms lead-in,
    start moved to a shot cut 2 frames later, edge pauses trimmed, the three new signals,
    `prompt` passed to a registered scorer and ignored by the heuristic, NTSC source
    gives a 30000/1001 sequence (plan D-15);
  - `view`: snapshot of the compact view for a fixture sequence;
  - path rule: `..`, encoded `..`, absolute, NUL, symlink escaping the project;
  - ingest guards: the filtering proxy refuses private-IP hosts, redirects to private
    IPs and a DNS name that resolves to 127.0.0.1; a concat/HLS file disguised as
    `.mp4` is rejected by `-format_whitelist`; an SVG disguised as PNG is rejected;
  - template variable validation, including nested `stack` panels;
  - ingest sources (plan D-13): URL classifier for YouTube/Instagram/TikTok forms and short
    links; yt-dlp argv snapshot with and without `--playlist` and with the cookies opt-in;
    recorded yt-dlp stderr for login-walled Instagram and TikTok posts maps to
    `LOGIN_REQUIRED`; a vertical 1080×1920 format list picks the 1080×1920 stream;
  - export targets: `-o` and `--out-dir` write there; missing or read-only folder →
    `EXPORT_PATH`; no replace without `--overwrite`; folder mode adds ` (2)`; a killed
    export leaves no partial file; `.otio` outside the project resolves its media;
  - sound cues and audio QA (plan D-14): cue list from fixtures (offsets, `entrance`,
    `sfxOff`, spacing and hero-spacing drops); each QA check fails on its generated bad
    fixture (late cue, two events in one sample, cues 50 ms apart, SFX over speech,
    clipped mix) and passes on a good one; `qa.png` and `LISTEN.md` are written.
- **Compile snapshots**: fixture projects → in-memory build snapshots, including
  `skipEntrance` on a scene shorter than its template's `minEntranceMs`, a preset's
  `case`/`stripPunctuation` applied in the build but not in the SRT, and facetrack
  keyframes as a `transform` (plan D-15).
- **HyperFrames contract tests**: `npx hyperframes lint --json` on the emitted build
  reports zero errors, and a 3 s fixture renders with `render --strict-all` and the
  expected frames, on the pinned version. A
  HyperFrames upgrade must pass these before the pin changes.
- **Audio graph**: the ffmpeg graph for a fixture timeline matches a snapshot; rendered
  click-track offsets are within 1 frame.
- **Python tools (pytest)**: request/response schemas; transcribe on a fixture; VAD
  regions on speech plus silence and music; facetrack detections on a face and a no-face
  fixture.
- **Offline fixture**: `test/fixtures/make.sh` builds a 20 s talking-head stand-in
  with ffmpeg `testsrc2` video and macOS `say` speech, plus the spike fixture. It also
  builds a 29.97 fps clip, a VFR phone-style clip and a clip with known hard cuts
  (plan D-15). The offline (CI) quick-clips project ships seeded `shots/<mediaId>.json`
  and `facetracks/<mediaId>.json` alongside the cached transcript and uses the seeded
  shots and facetrack files, so `auto` framing, shot snapping and the "Pin frame" E2E
  work offline.
- **Ingest and shots**: the VFR clip is detected and gets a CFR copy; a CFR clip does
  not; loudness is measured; `shots` finds every known cut of the cut fixture within
  1 frame.
- **Integration**: fixture → ingest (local) → transcribe → place linked clips + one
  `base/title` scene → captions → render draft → assert duration, resolution, audio
  stream, 3 non-blank sampled frames, and SRT export.
- **Manual end-to-end**: one real YouTube URL through ingest → render; one public
  Instagram reel and one public TikTok video through ingest.

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
8. `vox ingest` takes a public Instagram reel, a public TikTok video and a local video
   file; a login-walled post fails with `LOGIN_REQUIRED` and its hint; `vox render -o`
   and `--out-dir` write to a folder outside the project (plan D-13).
9. `vox audio-qa` on the GATE 2 clip writes `qa.json`, `qa.png` and `LISTEN.md`, and
   every check fails on its bad fixture (plan D-14).
10. `vox quick` on the 29.97 fps fixture and on the VFR fixture renders clips whose
    frames match the reference frames exactly; `removePauses` on a quick clip is one
    undo entry; a project with a newer `schemaVersion` is refused with `SCHEMA_TOO_NEW`
    and left unchanged (plan D-15).
