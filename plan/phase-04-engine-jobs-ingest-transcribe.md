# Phase 04 — Engine: jobs, Python bridge, ingest, transcribe, facetrack

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 01, 02 (uses the GATE 1 NTSC and filler results; may run in parallel with 03) |
| Spec § | engine "Repository layout" (Python bridge), "Stages" (`doctor`, `ingest`, `transcribe`, `shots`, `facetrack`), "Ingest analysis", "Speech gate and word kinds", "Shots and framing", "Encoding", "Ingest sources", "Ingest hardening", "Library API" (jobs, job results, events, config, redactor), "Error handling" |
| Model | Opus 5.5 · high |
| Gate | — |
| Next | 05 |

## Goal

Media gets into a project safely: any URL yt-dlp supports or a local file/folder, with every network
and file-format guard from the spec. VFR video gets a constant-rate copy and every source a loudness
measure. Speech becomes word-timed transcripts behind a speech gate; videos get a shot list; faces, bodies
and saliency become crop keyframes that never drift across a cut. All of it runs as cancellable, cached
jobs with progress, and each job's result is one undo entry (D-15).

## Required reading

- Engine spec sections above; `plan/ref/R4-security.md` rows S2–S6, S17, S19, S33; R5 Python rows;
  DECISIONS D-13, D-15; the GATE 1 entry (NTSC result, filler survival).

## Output

- `engine/src/jobs.ts`: job runner (concurrency 2; at most one GPU job), `start/get/cancel/list/register`,
  events `job.started|progress|done|failed|cancelled`, `AbortSignal` kills child processes. Job results
  (D-15): a job that writes to the model records the project `version` as `baseVersion` at start and
  applies its result as one `batch` with its `jobId` (02's `applyOp` check); an entry after
  `baseVersion` that touched a key the batch touches fails the job with `JOB_CONFLICT` (keys listed),
  and nothing is overwritten.
- `engine/src/py.ts`: typed bridge (`uv run --frozen --project <py> python -I -m vox_py.<tool>`; with a
  tools directory it adds `--no-sync` and sets `UV_PROJECT_ENVIRONMENT=<tools>/py-env`,
  `UV_CACHE_DIR=<tools>/uv-cache` and `UV_PYTHON_INSTALL_DIR=<tools>/python`, so nothing is written into
  the app bundle and `uv.lock` is never rewritten (engine "Repository layout", D-12)), zod on both sides,
  stderr JSON-lines progress, last 40 stderr lines into `cause`, passed through `engine.redactor.redact`.
- `engine/src/config.ts`: the only reader/writer of `~/.vox/config.json`; `readConfig()`,
  `writeConfig(patch)` (merges the patch, keeps other keys such as `contact` and `projectsDir`); file and
  temp file created with mode `0600` from the first write (S17). `resolveProjectsDir` (02) now reads
  `projectsDir` from it (order: flag > env > config > default, D-10).
- `engine/src/redact.ts`: `engine.redactor` with `addSecrets(values)` and `redact(text|object)`; built-in
  patterns (`Authorization`/`x-api-key` headers, `sk-…`, `Bearer …`, `key=`/`api_key=` query values);
  applied to `VoxError.cause`, job errors, logs and events (S19; the agent registers key values in 11).
- `engine/src/net/`: local filtering proxy (resolves each host itself, refuses private/loopback/link-local/
  multicast, connects to the checked IP); in-process check for engine downloads.
- `engine/src/stages/sources.ts` (D-13): `classifyUrl(url)` → `youtube | instagram | tiktok | other |
  invalid` (YouTube watch/`youtu.be`/Shorts, Instagram reel/post/IGTV, TikTok video page and `vm.`/`vt.`
  short links; only `http(s)` is valid); used for the UI badge and hints, never to pick a download path.
- `engine/src/stages/ingest.ts`: URL (yt-dlp via proxy with the spec flags: `-f "bv*+ba/b" -S "res:1080"`,
  `--playlist-items 1` unless `--playlist`; `--js-runtimes node` when deno is absent;
  `--cookies-from-browser <b>` only when `ingest.cookiesFromBrowser` is set in the config) or local
  file/folder (copied, never symlinked; MP4/MOV/M4V/WebM/MKV video detected from content); yt-dlp stderr
  for login walls, private posts and rate limits → `LOGIN_REQUIRED` with the spec hint; the result
  reports how many videos a multi-video post had; content-sniffed type; ffprobe metadata;
  ingest analysis (D-15): source `fps` from `r_frame_rate`; VFR check (`r_frame_rate` ≠ `avg_frame_rate`,
  or pts deltas spread over more than 1 frame) → `media/<id>.cfr.mp4` at the fixed-set rate nearest the
  average (libx264 `-crf 18`, audio copied; nearest integer rate if GATE 1 recorded the NTSC fallback),
  `vfr: true`, `cfrPath`, and the proxy made from the copy; `ebur128` (true peak on) →
  `loudness { integratedLufs, truePeakDb }` for each audio-bearing source;
  540p all-keyframe proxy (libx264, per engine "Encoding"), extracted `audio/*.m4a`, thumbs sprite
  (1 frame / 2 s), peaks JSON; documents (`.txt`, `.md`, `.fountain`; `.pdf` via
  `py/vox_py/doctext.py` with pypdf) to plain text; `addMedia`. Cache by input hash.
  `ingest({ proxies: false })` / `vox ingest --no-proxies` skips proxy, thumbs and peaks (used by 15).
- `py/vox_py/vad.py` (D-15): Silero VAD through `onnxruntime` (no torch); the ONNX model vendored at
  `py/vox_py/models/silero_vad.onnx` with its MIT licence, SHA-256 checked on load (pin in R5); returns
  speech regions. Nothing is downloaded at run time.
- `py/vox_py/transcribe.py`: speech gate first (`vad.py`), then mlx-whisper, pinned model revision, auto
  language, word timestamps, with an `initial_prompt` built from the English filler list (D-15). Clips
  each word to the speech region it overlaps most and drops words that overlap none by 40 ms (D-21), and
  drops whole segments with `no_speech_prob > 0.6`
  or `compression_ratio > 2.4`. The engine then runs 02's `computeWordKinds`, writes
  `transcripts/<id>.json` with `speechRegions` and updates `transcriptRev`.
- `engine/src/stages/shots.ts` (D-15): ffmpeg `scdet` (threshold 10, about `scene > 0.35`) on the proxy (on
  the original scaled to 360p when the media has no proxy, e.g. a `{ proxies: false }` ingest) →
  `shots/<id>.json` = `{ startMs, endMs }[]` covering the whole media, `shotsPath` set; job kind `shots`;
  no Python. TransNetV2 is the documented fallback, not built.
- `py/vox_py/facetrack.py` (redesigned, D-15): samples at 12 fps on the proxy scaled to 360p (the original
  when there is no proxy); per sample
  the faces (MediaPipe `FaceDetector`, full-range `.tflite`, pinned URL + hash), body boxes (Vision
  `VNDetectHumanRectanglesRequest`) and the attention saliency box (Vision
  `VNGenerateAttentionBasedSaliencyImageRequest`, `pyobjc-framework-Vision`, now a v1 dependency) →
  `facetracks/<id>.json`, once per media.
- `engine/src/stages/facetrack.ts` path builder (TS, D-15): detections + shot list → crop keyframes
  `{ atMs, x, y, scale }`. Smoothing resets at every shot boundary; subject per shot (`facetrack`: faces,
  else centre; `auto`: face → body → saliency → centre; `faceIndex` pins one face); hysteresis (keep the
  current face unless another is > 30 % larger for ≥ 1 s); `stability` `locked` (one static crop per shot
  inside a 10 % dead zone, else `smooth`), `smooth`, `follow`; `trackSpeed` limits crop speed; user
  keyframes pin the crop and blend back over 300 ms; cached under (media hash, aspect, mode, stability,
  trackSpeed). Built and tested standalone here; phase 05 plugs it into 03's compile path-provider
  interface.
- `vox doctor` (tools, versions, Chromium, models + licences incl. the vendored Silero model's SHA-256,
  prints fixes), `vox ingest`, `vox transcribe`, `vox shots <project> <mediaId>` (D-15), `vox facetrack`,
  `vox media-frames`.
- `engine.mediaFrames()` (ffmpeg stills, cached).

## Steps

### A. Jobs and bridge

1. [ ] Job runner tests: concurrency, GPU exclusivity, cancel kills the child, progress events, `register`.
1b. [ ] Job results (D-15): a job records `baseVersion` and applies one `batch` with `jobId` (one history
        entry); a user edit to an entity the job writes, made while it runs, fails the job with
        `JOB_CONFLICT` and changes nothing; an unrelated edit does not.
2. [ ] Config tests: first write creates the file `0600`; `writeConfig` patch keeps other keys; a
        concurrent write does not lose a key (S17). Redactor tests: each pattern, `addSecrets` values,
        nested objects, `VoxError.cause` redacted (S19).
3. [ ] Bridge tests with a fake tool: schema mismatch fails cleanly; progress parsed; stderr tail captured;
       argv has `--frozen` and the env has `UV_PROJECT_ENVIRONMENT`/`UV_CACHE_DIR` when a tools dir is set.
       Config test: `projectsDir` in the config is used when no flag or env is set.
       pytest per Python tool (`vad`, `transcribe`, `facetrack`, `doctext`): its JSON output validates against the
       JSON Schema exported from the zod schema (`py/tests/schemas/`), so both sides agree.

### B. Ingest hardening (tests first, all S-rows)

4. [ ] Proxy (S3): refuses private IP host, redirect to private IP, DNS name resolving to 127.0.0.1; allows a
       public host (local test server bound via a fake resolver, no internet in CI).
5. [ ] yt-dlp argv snapshot (S4): default, with `--playlist` (no `--no-playlist`, no `--playlist-items`)
       and with the cookies opt-in (S33: the flag appears only when the config key is set, and the key
       cannot come from a URL, a project file or an ingest argument); output name is engine-generated.
5b. [ ] Sources (D-13): `classifyUrl` table test (each platform's URL forms, short links, `ftp:`/`file:`
       → `invalid`); recorded yt-dlp stderr for a login-walled Instagram post, a private TikTok and a
       rate limit → `LOGIN_REQUIRED` with the hint; a recorded format list of a 1080×1920 reel → the
       1080×1920 stream is chosen (`yt-dlp --load-info-json <recorded> --simulate -j` with the engine's
       format flags, no network); a recorded carousel info JSON → first video taken, count reported.
6. [ ] ffmpeg/ffprobe argv always carry `-format_whitelist` for the detected type and
       `-protocol_whitelist file,pipe`; concat/HLS disguised as `.mp4` rejected (S5).
7. [ ] Type sniffing: SVG disguised as PNG rejected; HTML rejected; images re-encoded (S6).
8. [ ] Folder ingest copies files; a symlink pointing out of the folder is not followed (S2).

### C. Stages

9. [ ] Ingest local `talking-head-20s.mp4` (and its `.mov` remux and `.webm` re-encode, all checked in
       under `fixtures/assets/media/` by phase 00, D-13, D-16): proxy (libx264 args snapshot), audio, thumbs, peaks, metadata,
       `addMedia`, idempotent rerun; `{ proxies: false }` produces no proxy/thumbs/peaks; a `.pdf` fixture
       becomes text through `doctext.py`.
9b. [ ] Ingest analysis (D-15): `phone-vfr-20s.mp4` is detected as VFR and gets a CFR copy (`cfrPath`,
        constant pts deltas, proxy made from it); `talking-head-20s.mp4` is not VFR and gets no copy;
        `ntsc-2997-20s.mp4` stores `fps` 30000/1001; `loudness` is measured on each audio-bearing fixture.
9c. [ ] Shots (D-15): `vox shots` on `cuts-2shot.mp4` finds every cut in `cuts-2shot.cuts.json` within 1 frame
        and covers the whole media; cached on rerun. A `{ proxies: false }` ingest of the same file gives
        the same shot list within 1 frame, and facetrack on it runs from the original at 360p with the
        same per-shot subjects.
10. [ ] Transcribe (slow test): words with timestamps on the fixture; language detected; cached. Commit
        the result as `packages/engine/test/fixtures/transcripts/talking-head-20s.json` (R7), so later
        phases (05 offline project, 11, 12) never need mlx-whisper in CI. Transcribe the checked-in
        `assets/media/talking-head-20s.mp4`, so the media hash in the seed matches on every Mac and on CI
        (D-16); the same applies to the seeded `shots/<mediaId>.json` and `facetracks/<mediaId>.json`.
10b. [ ] Speech gate (D-15): vendor `silero_vad.onnx` + licence, record its upstream URL and SHA-256 in R5; a
        changed file fails the SHA check. pytest: VAD regions on `music-silence.wav` cover only the spoken
        sentence. Slow test: no words survive over the music and silence; segments over the
        `no_speech_prob` or `compression_ratio` limits are dropped (unit test with a recorded Whisper
        result); `speechRegions` written; on `speech-fillers.wav` the fillers that survive get
        `kind: 'filler'` and the repeat `kind: 'repeat'`.
11. [ ] MediaPipe check first: the full-range `.tflite` loads in the pinned MediaPipe Tasks version and
        detects both faces on `face-2people.mp4`. If it does not, use the short-range model and log D-NN.
12. [ ] Facetrack: `face-2people.mp4` picks the largest; `faceIndex` override; keyframes smoothed.
12b. [ ] Vision check first (D-15): `pyobjc-framework-Vision` loads under `python -I` in the uv env; body and
        saliency requests return boxes on a fixture frame. pytest: detections on a face fixture and a
        no-face fixture.
12c. [ ] Path builder (D-15): on `cuts-2shot.mp4`, the first keyframe after each shot boundary is on the new
        shot's subject (no drift across a cut), and in `auto` the no-face shot uses saliency; on
        `podcast-2face.mp4`, the 0.5 s growth does not switch subject and the 1.5 s growth does;
        `locked` gives one crop per shot; a user keyframe pins the crop and blends back over 300 ms; a
        start trim shifts it; a changed `stability` or `trackSpeed` misses the cache.
13. [ ] `vox doctor` lists every tool with version and a fix line when missing; warns on node-only yt-dlp.
        `vox doctor <project>` reports caption-override orphans; `vox doctor <project> --unlock` removes a
        lock (the only way to clear another host's lock). The first `vox doctor` run asks once for a
        contact (email or URL) for the Wikimedia Commons User-Agent and saves it as `contact` with
        `writeConfig` (`--json` and non-TTY runs skip the prompt and report it as missing).
14. [ ] Network stages retry 3× with backoff; ingest error hint suggests a local path when yt-dlp fails.

### D. Manual

15. [ ] MANUAL STEP (owner, optional — does not block merge; required later at GATE 2): `vox ingest` one
        real YouTube URL, the Instagram reel URL and the TikTok URL from TODO.

## Verify

```bash
pnpm -C packages/engine test
pnpm -C packages/engine test:slow -- stages
uv run --project py pytest
pnpm -C packages/cli exec vox doctor --json
```

## Done when

- [ ] S2–S6, S17, S19 and S33 tests pass; security review clean of CRITICAL/HIGH.
- [ ] Sources tests pass: URL classes, `LOGIN_REQUIRED` mapping, vertical 1080×1920 format choice,
      carousel first item (D-13).
- [ ] Fixture ingest → shots → transcribe → facetrack works by CLI, cached on rerun; each job is one
      history entry and fails `JOB_CONFLICT` on a conflicting edit (D-15).
- [ ] VFR detection + CFR copy, loudness, speech gate, word kinds, shots and the facetrack path tests pass
      (D-15).
- [ ] `vox doctor` passes on the M5 (provisional; engine done-when #2 is owned by 05 and checked at GATE 2).
- [ ] R5 rows for mlx-whisper model revision, MediaPipe model, `onnxruntime`, the vendored
      `silero_vad.onnx` (SHA-256) and `pyobjc-framework-Vision` are filled.

## Risks and fallback

| Risk | Fallback |
|---|---|
| yt-dlp YouTube extraction needs a newer `yt-dlp-ejs` | `vox doctor` offers `yt-dlp -U`; record the version that worked |
| Instagram blocks anonymous downloads | `LOGIN_REQUIRED` hint → drop the file, or the user's cookies opt-in (D-13); never a built-in account |
| TikTok needs `--impersonate` and the yt-dlp build lacks it | `vox doctor` reports it; record in R5 which yt-dlp build works; hint suggests the file path |
| Proxy breaks yt-dlp HTTPS (CONNECT) | Implement CONNECT tunnelling with the IP check before connect; test against a local TLS server |
| mlx-whisper model download size surprises users | Size shown before download (app shows it in phase 09) |
| `scdet` misses cuts on the fixture | Tune the threshold and log it; TransNetV2 stays a documented fallback, not built in v1 (D-15) |
| Vision requests fail under `python -I` in the uv env | Record it; `auto` falls back from face to centre and the log says so (no silent fallback); log D-NN |
| Silero ONNX input shape differs from the vendored version's docs | Pin the model file that matches the pinned `onnxruntime`; pytest on `music-silence.wav` guards it |

## Handoff notes

- Phase 05 adds `assets.*` and `render`/export jobs on the same runner, and runs `shots` in the
  quick-clips chain; quick clips use `speechRegions` for the speech ratio and facetrack for coverage (D-15).
- Phase 05 plugs the facetrack path builder into 03's compile path-provider interface; 04 builds and
  tests it standalone only.
- Phase 05 reads `contact` with `readConfig()` for the Commons User-Agent.
- Phase 11 stores provider entries through `readConfig`/`writeConfig` and registers key values with
  `engine.redactor.addSecrets`; it adds no second config writer or redactor.
- Phase 15 calls `ingest({ proxies: false })` for reference videos.
