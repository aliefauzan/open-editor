# Phase 05 — Engine: assets, render, export, CLI + GATE 2

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 03, 04 |
| Spec § | engine "Stages" (assets, render, frames, exports, credits, "Quick clips", `audio-qa`), "Export targets", "Audio QA", "Archive assets and licences", "Image generation provider", "Library API", "Testing" (integration, manual E2E), "Done when" |
| Model | Sonnet 5.5 · high |
| Gate | **GATE 2** at the end (engine done-when) |
| Next | 06/07, 09, 11 |

## Goal

The engine is complete for v1: archive images with licences, cutouts, final MP4 render, stills,
captions and OTIO export, credits, and a full `vox` CLI. From a real YouTube URL, CLI commands alone
produce a captioned 9:16 clip, and `vox quick <url>` does the simple path in one command: plain
captioned clips with editable subtitles and no AI key (D-11).

## Required reading

- Engine spec sections above incl. "Quick clips" and "Captions" (editing); R4 rows S7, S29, S32; R5 rembg +
  opentimelineio rows; DECISIONS D-11, D-13, D-14, D-15.
- Inputs from TODO: the YouTube, Instagram and TikTok URLs (GATE 2); the Commons contact if given
  (without it Commons search runs throttled at 10/min, D-12). If the URLs are not in TODO yet, the AI
  proposes public candidates there (the owner's own posts first, else videos with a reuse licence) and
  the owner confirms them before step 14 (D-16). Keys stay the owner's.
- GATE 1 decision (whole-sequence vs hybrid export; NTSC go or integer-rate fallback, D-15).

## Output

- `engine/src/stages/assets.ts`: Commons + Openverse search (allowlist CC0/PDM/BY/BY-SA; Openverse
  `license=cc0,pdm,by,by-sa`, `page_size` ≤ 20; Commons User-Agent with contact from `readConfig()`,
  10/min throttle without it; `Artist` HTML sanitised), results cached in `cache/assets/<queryHash>.json`;
  `fetch` (records licence/author, origin `archive`); `cutout` (rembg, pinned permissive model, refused
  for ND; transparent PNG as new media); `generate` via registered `ImageProvider` (fails with hint when none).
- `py/vox_py/cutout.py`, `py/vox_py/timeline.py` (OTIO).
- `engine/src/stages/render.ts`: picture via HyperFrames (silent, `--quality` passed explicitly) or the
  hybrid compositor, muxed with the audio graph (`-c:v copy`, audio AAC, per engine "Encoding");
  `--range-ms`; `--all`; `--loudness youtube|tiktok|broadcast` (−14 / −12 / −23 LUFS, default `youtube`;
  passed to 03's audio graph, D-15); output in `renders/` unless a target is given.
- `engine/src/export/target.ts` (D-13): export targets per engine "Export targets" — `{ file }` or
  `{ dir }`, absolute, folder must exist and be writable (`EXPORT_PATH`), temp file + rename in the
  target folder, no replace without `overwrite`, folder mode ` (2)` suffix, written paths in the job
  result; used by `render`, `exportCaptions`, `exportTimeline` (OTIO outside the project: absolute media
  references, layer MOVs in `<name>-layers/`). CLI `-o`, `--out-dir`, `--overwrite`; `vox quick
  --out-dir`.
- `py/vox_py/audioqa.py` + `py/vox_py/audioqa_thresholds.json` (D-14): job kind `audioQa` and
  `vox audio-qa [--loudness preset]` per engine "Audio QA" (stems + mix through ffmpeg PCM, numpy
  onset/loudness checks, loudness against the chosen target ±1 LU; the thresholds file stores the
  tolerance, not the target, D-15;
  `qa.json`, `qa.png` drawn with numpy and numbered cue markers (no `drawtext`, D-27), `LISTEN.md`), and `--kit
  <styleId>` for the SFX rules (styles spec) with a kit sheet image.
- Facetrack path provider (moved from 04): plugs 04's facetrack path builder into 03's compile
  path-provider interface, replacing 03's fixture stub, so `facetrack` and `auto` clips compile with
  the real crop keyframes.
- `engine.frames()` (compiled stills at canvas size, cached).
- Exports: `export-captions` (SRT/VTT from `deriveCaptions`), `export-timeline` (`.otio` referencing
  originals + layer MOVs), `credits`.
- `imageProviders.register/list`.
- `engine/src/stages/quickClips.ts` (D-11): job kind `quickClips` per engine "Quick clips" (sentence
  units, candidates in `[minMs, maxMs]`, heuristic scorer, top `count` without overlap, one `batch`
  creating `base` sequences with a linked `V1`/`A1` pair and `base/plain` captions);
  `engine.quickClips.registerScorer(id, fn)` / `scorers()`; a failing scorer falls back to the heuristic.
  D-15: runs after the chain ingest → `shots` → transcribe → facetrack; boundaries (start 120 ms
  before the first word, never inside the previous word; a start within 2 frames before a shot cut moves to the cut; edge
  pauses trimmed); speech ratio from `speechRegions`; three more heuristic signals scaled 0..1 with
  equal weight: energy (short-term loudness variance), hook (first sentence is a question or holds a
  number), coverage (share with a face on screen); `prompt?` passed to a registered scorer and ignored
  by the heuristic; `V1` with `auto` framing; sequence fps = the source's rate when in the fixed set,
  else the nearest; the `batch` carries the job's `jobId` ("Undo quick clips" is one entry).
- `render --captions burn|none` (default `burn`).
- CLI: `vox assets search|fetch|cutout|generate`, `vox compile`, `vox preview`, `vox frames`,
  `vox render` (`--loudness`), `vox audio-qa` (`--loudness`), `vox export-captions`, `vox export-timeline`,
  `vox credits`, `vox quick` (chain ingest → shots → transcribe → facetrack → quickClips) — every
  command `--json`.
- `scripts/make-offline-project.ts`: builds the offline fixture project (R7) from the checked-in
  `assets/media/talking-head-20s.mp4` (D-16) and the checked-in `transcripts/talking-head-20s.json`, without network or mlx-whisper; it ships
  seeded `shots/<mediaId>.json` and `facetracks/<mediaId>.json` alongside the cached transcript and
  uses the seeded shots and facetrack files, so `auto` framing, shot snapping and the "Pin frame" E2E
  work offline; used by the app E2E (10b, 13) and the agent mock-model tests (12).
- Integration test and `docs/evidence/phase-05/`.

## Steps

### A. Assets

1. [ ] Licence filter tests (S7): NC/ND/other dropped; BY-SA warning; ND cutout refused.
2. [ ] Search against recorded HTTP fixtures (no live network in tests); live smoke test tagged `slow`.
       A recorded empty result → the job result says "no results" and nothing is generated or
       substituted (engine "Error handling", D-12).
       S29: `fetch` of an archive URL whose host resolves to a private/loopback address, or that redirects
       to one, is refused by the in-process check (fake resolver, no internet).
3. [ ] Cutout on a fixture image produces alpha PNG; record the rembg model and quote its licence in the log.
       pytest for `cutout.py` and `timeline.py`: outputs validate against their JSON Schemas (as in 04).
4. [ ] `ImageProvider` interface + a fake provider test; `generate` without a provider → hint.

### B. Render and export

5. [ ] Render fixture: duration, resolution 1080×1920, audio stream, 3 non-blank sampled frames.
6. [ ] SRT/VTT export matches `deriveCaptions` chunks; timing on the frame grid.
7. [ ] OTIO export: schema-valid; clips reference originals; scene/caption layers as MOVs with alpha.
8. [ ] `credits` lists every archive asset used with author, licence and link.
8b. [ ] `vox preview` (D-12): compiles and spawns `npx hyperframes play <buildDir>` with an argument array
        (spawn spy; no browser in CI); `--seq` picks the sequence; an unknown sequence fails with a hint.
8c. [ ] Export targets (S32, D-13): `render -o <tmp>/a.mp4` and `--out-dir <tmp>` write there and the
        result lists the paths; missing folder and read-only folder → `EXPORT_PATH`; an existing file is
        not replaced without `--overwrite`; `--out-dir` twice → `… (2).mp4`; a render killed mid-write
        leaves no file in the target folder; `--all` writes one file per sequence; `export-captions -o`
        and `export-timeline --out-dir` likewise, and the moved `.otio` opens with `opentimelineio` and
        resolves every media reference; no target → `renders/` as before.
8d0. [ ] Extend `make.sh` with the audio QA set (R7 row, D-16): `audio/good.wav` from the checked-in
        `tap.wav` and `say` speech, the five bad mixes (cue 3 frames late, two hits in one sample, two cues
        50 ms apart, SFX over speech at equal loudness, mix clipped at 0 dBFS) and the kit set (sine beep,
        noise bed, click-at-start, double-hit sample). The 00 fixture test checks each file's duration
        and channel count.
8d. [ ] Audio QA (D-14): bad fixtures from `make.sh` (step 8d0) each fail exactly their check — cue 3 frames
        late, two hits in one sample, two cues 50 ms apart, SFX over speech at equal loudness, mix
        clipped at 0 dBFS; the good fixture passes all; `qa.json` numbers, `qa.png` (exists, canvas
        size, one marker per cue) and `LISTEN.md` (five timecodes, hero cues first) are written. Kit mode:
        generated sine beep, noise bed, click-at-start and double-hit samples each fail their rule; the
        checked-in CC0 `tap.wav` passes. pytest for `audioqa.py` validates its JSON Schema (as in 04).
8e. [ ] Loudness target (D-15): `render --loudness` `youtube`, `tiktok` and `broadcast` each measure at
        their target ±1 LU (ffmpeg `ebur128`); `audio-qa --loudness tiktok` passes a `tiktok` render and
        fails a `broadcast` render on the loudness check; `audioqa_thresholds.json` holds the ±1 LU
        tolerance, unchanged.

### C. Integration (engine "Testing")

9. [ ] Fixture → ingest (local) → transcribe → place linked clips + one `base/title` scene → captions →
       render draft → assert duration, resolution, audio, 3 non-blank frames, SRT export.

9b. [ ] Facetrack path provider (moved from 04): with 04's path builder plugged into 03's path-provider
        interface, a `facetrack` and an `auto` clip on `cuts-2shot.mp4` compile to `transform` keyframes
        equal to the builder's output (no fixture stub left); a changed `stability` recompiles.
10. [ ] `make-offline-project.ts` runs in CI (no network) and the result opens, compiles and renders a
        draft; its seeded `shots/<mediaId>.json` and `facetracks/<mediaId>.json` are used (no
        facetrack or shots job runs), and an `auto` clip in it compiles with tracked keyframes.
11. [ ] A/V sync (moved here from 03): `render` the engine-compiled 90 s spike fixture (picture + mux);
        click-track onsets vs burnt-in flash frames < 1 frame (spike bench reused). Numbers in the log.

### C2. Quick clips (D-11)

12. [ ] `quickClips` tests on the offline project with `{ count: 3, minMs: 4000, maxMs: 8000 }`: 3
        clips; each starts and ends on a sentence boundary and fits the bounds; no overlaps; same input
        → same ranges; too few candidates → fewer clips, reported; each sequence has `styleId: 'base'`,
        `sourceRange`, a linked `V1`/`A1` pair with equal offsets (framing `auto` in every case, D-15),
        captions `base/plain` with `maxWords` 3, and no scenes. A registered fake scorer changes the pick; a
        throwing scorer falls back to the heuristic and the result names the scorer used.
12b. [ ] Quick clips D-15 tests: 120 ms lead-in (never inside the previous word); a start 2 frames before a
        shot cut moves to the cut; edge pauses trimmed (clip ends at its last word's end); each new signal
        (energy, hook, coverage) changes the pick on a crafted candidate set; `prompt` reaches a registered
        scorer and the heuristic ignores it; one history entry with `jobId`, one undo removes all clips;
        an NTSC source gives a 30000/1001 sequence (an integer rate if GATE 1 recorded the fallback).
13. [ ] Caption edit round trip: one `setCaptions` override replaces a word's text and nudges its
        `startMs` → `export-captions` SRT shows the new word and time; the compiled caption layer at
        that time contains the new word (DOM text check); `render --captions none` has no caption
        layer; `vox quick <fixture path> --count 3 --length 4-8 --render` writes 3 MP4 + 3 SRT.

### D. GATE 2 (owner + agent)

14. [ ] Real URL run (agent prepares one script `scripts/gate2.sh <url>`, URL from TODO): ingest →
        shots → transcribe → facetrack → `vox new` + ops for a face-tracked speaker clip, one `base/title`, a
        transition, captions → render + SRT. Evidence: MP4 + 3 frames + SRT head in `docs/evidence/phase-05/`.
        The same script then runs `vox quick <url> --render` (3 captioned clips), edits one caption
        word with `vox op … setCaptions` and re-renders; evidence: SRT head and a frame with the edit
        (done-when 7). Then (done-when 8, D-13): `vox ingest` of the Instagram reel and the TikTok URL from
        TODO (evidence: ffprobe of each, 1080×1920 kept when the source has it; a login-walled post shows
        `LOGIN_REQUIRED`, and with the owner's cookies opt-in it ingests), `vox quick <local file>
        --render --out-dir <evidence>/out`; then `vox audio-qa` on the clip (done-when 9, D-14; evidence:
        `qa.json`, `qa.png`, `LISTEN.md`). Then (done-when 10, D-15): `vox quick` on `ntsc-2997-20s.mp4`
        and `phone-vfr-20s.mp4` with `--render`, frames compared with the reference frames by their
        burnt-in counters; `removePauses` on one quick clip, then one `vox undo` restores it; a copy of
        the project with a higher `schemaVersion` is refused with `SCHEMA_TOO_NEW` and stays
        byte-identical. Evidence: the frame comparison JSON and the undo check.
        Platform fallback (D-16): if a YouTube, Instagram or TikTok ingest fails because of the platform
        (the failure stays after `yt-dlp -U`), record the yt-dlp version and stderr in the log. That
        platform still passes when the same video as a local file passes and the link fails with
        `LOGIN_REQUIRED` or another `VoxError` with a clear hint. Log it as a known issue for GATE 5.
15. [ ] MANUAL STEP: open the `.otio` in DaVinci Resolve 18.5+; screenshot clips + layer MOVs (with alpha)
        in place. Fallback chain (D-10), prepared before asking: if Resolve rejects the OTIO, the agent adds
        FCPXML export through `otio-fcpx-xml-adapter` (pinned in R5; 14g then only adds the app option)
        and the owner tries that; if both fail, the agent writes README steps that put the layer MOVs in
        place by hand and the owner follows them once. Any of the three passes item 5.
16. [ ] Check engine done-when 1–10, then STOP for GATE 2.

## Verify

```bash
pnpm test
pnpm -C packages/engine test:slow -- integration
pnpm -C packages/engine test -- export-target audio-qa
uv run --project py pytest -k audioqa
bash scripts/gate2.sh --youtube "<url>" --instagram "<url>" --tiktok "<url>"   # URLs from TODO; own temp projects folder unless --projects-dir
```

## Done when (= engine spec "Done when")

- [ ] 1 spike result and pin in the engine spec (from 01).
- [ ] 2 `vox doctor` passes on the M5.
- [ ] 3 `pnpm test` passes from a clean checkout.
- [ ] 4 Real YouTube URL → 9:16 MP4 with face-tracked speaker, `base/title`, transition, captions + SRT.
- [ ] 5 `.otio` opens in Resolve with clips and layer MOVs in place (owner screenshot), or the FCPXML /
      manual-import fallback passed (D-10).
- [ ] 6 Recovery test (from 02) passes.
- [ ] 7 `vox quick <url>` with no provider → 3 captioned 9:16 clips (MP4 + SRT with `--render`); an
      edited caption word shows in the SRT and the MP4 (D-11).
- [ ] 8 Instagram reel, TikTok video and local file ingest; `LOGIN_REQUIRED` hint; `-o`/`--out-dir` write
      outside the project (D-13).
- [ ] 9 `vox audio-qa` writes `qa.json`, `qa.png`, `LISTEN.md`; every check fails on its bad fixture (D-14).
- [ ] 10 `vox quick` on the 29.97 fps and the VFR fixtures renders clips whose frames match the reference
      frames exactly; `removePauses` on a quick clip is one undo entry; a project with a newer
      `schemaVersion` is refused with `SCHEMA_TOO_NEW` and left unchanged (D-15).
- [ ] A/V sync < 1 frame on the 90 s fixture after the mux (step 11).
- [ ] The facetrack path builder from 04 is plugged into the compile path-provider interface (step 9b).
- [ ] S7, S29 and S32 tests pass; security review clean of CRITICAL/HIGH.
- [ ] GATE 2 answered and recorded.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Resolve does not import OTIO with MOV alpha as expected | Step 15 fallback chain: FCPXML via `otio-fcpx-xml-adapter`, then documented manual import (D-10) |
| No permissive rembg model fits | Ship cutout disabled with a clear hint; `paper-collage` uses rectangles with red border |
| Commons rate limits | Contact from TODO; throttle; cache |
| Onset detection unreliable on soft SFX | Detect on the SFX stem only (no speech in it); thresholds tuned once on the good fixture, then frozen (D-14) |
| Instagram URL needs a login at GATE 2 | The owner's cookies opt-in passes item 8; if no browser login exists, item 8 passes with the `LOGIN_REQUIRED` hint plus the local-file path, noted in the log |
| A platform breaks yt-dlp at GATE 2 (YouTube, Instagram or TikTok) | Platform fallback in step 14 (D-16): local file of the same video passes, the link fails with a clear `VoxError` hint, yt-dlp version and stderr logged; checked again at GATE 5 |

## Handoff notes

- Phase 07 templates use `assets.*` fixtures; phase 11 agent job tools map 1:1 to these jobs.
- 10b builds the Quick clips start screen and the Subtitles panel on `quickClips` and `setCaptions`;
  12 registers the LLM scorer and adds the Stylize workflow (D-11). Stylize and the clipper default to
  cover-style transitions at clip edges, since quick clips have no handles (D-15).
- Engine API, events and engine CLI are frozen after GATE 2 (R2; PROGRESS milestone "frozen after 05").
