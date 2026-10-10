# Phase 04 — Engine: jobs, Python bridge, ingest, transcribe, facetrack

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 02 (may run in parallel with 03) |
| Spec § | engine "Repository layout" (Python bridge), "Stages" (`doctor`, `ingest`, `transcribe`, `facetrack`), "Encoding", "Ingest hardening", "Library API" (jobs, events, config, redactor), "Error handling" |
| Model | Opus 5.5 · high |
| Gate | — |
| Next | 05 |

## Goal

Media gets into a project safely: any URL yt-dlp supports or a local file/folder, with every network
and file-format guard from the spec. Speech becomes word-timed transcripts; faces become crop keyframes.
All of it runs as cancellable, cached jobs with progress.

## Required reading

- Engine spec sections above; `plan/ref/R4-security.md` rows S2–S6, S17, S19; R5 Python rows.

## Output

- `engine/src/jobs.ts`: job runner (concurrency 2; at most one GPU job), `start/get/cancel/list/register`,
  events `job.started|progress|done|failed|cancelled`, `AbortSignal` kills child processes.
- `engine/src/py.ts`: typed bridge (`uv run --frozen --project <py> python -I -m vox_py.<tool>`; with a
  tools directory it sets `UV_PROJECT_ENVIRONMENT=<tools>/py-env` and `UV_CACHE_DIR=<tools>/uv-cache`, so
  nothing is written into the app bundle and `uv.lock` is never rewritten), zod on both sides,
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
- `engine/src/stages/ingest.ts`: URL (yt-dlp via proxy with the spec flags; `--js-runtimes node` when
  deno is absent) or local path/folder (copied, never symlinked); content-sniffed type; ffprobe metadata;
  540p all-keyframe proxy (libx264, per engine "Encoding"), extracted `audio/*.m4a`, thumbs sprite
  (1 frame / 2 s), peaks JSON; documents (`.txt`, `.md`, `.fountain`; `.pdf` via
  `py/vox_py/doctext.py` with pypdf) to plain text; `addMedia`. Cache by input hash.
  `ingest({ proxies: false })` / `vox ingest --no-proxies` skips proxy, thumbs and peaks (used by 15).
- `py/vox_py/transcribe.py`: mlx-whisper, pinned model revision, auto language, word timestamps.
- `py/vox_py/facetrack.py`: MediaPipe `FaceDetector` (full-range `.tflite`, pinned URL + hash) at 5 fps,
  all faces, largest by default, smoothed crop-centre keyframes.
- `vox doctor` (tools, versions, Chromium, models + licences, prints fixes), `vox ingest`,
  `vox transcribe`, `vox facetrack`, `vox media-frames`.
- `engine.mediaFrames()` (ffmpeg stills, cached).

## Steps

### A. Jobs and bridge

1. [ ] Job runner tests: concurrency, GPU exclusivity, cancel kills the child, progress events, `register`.
2. [ ] Config tests: first write creates the file `0600`; `writeConfig` patch keeps other keys; a
        concurrent write does not lose a key (S17). Redactor tests: each pattern, `addSecrets` values,
        nested objects, `VoxError.cause` redacted (S19).
3. [ ] Bridge tests with a fake tool: schema mismatch fails cleanly; progress parsed; stderr tail captured;
       argv has `--frozen` and the env has `UV_PROJECT_ENVIRONMENT`/`UV_CACHE_DIR` when a tools dir is set.
       Config test: `projectsDir` in the config is used when no flag or env is set.
       pytest per Python tool (`transcribe`, `facetrack`, `doctext`): its JSON output validates against the
       JSON Schema exported from the zod schema (`py/tests/schemas/`), so both sides agree.

### B. Ingest hardening (tests first, all S-rows)

4. [ ] Proxy: refuses private IP host, redirect to private IP, DNS name resolving to 127.0.0.1; allows a
       public host (local test server bound via a fake resolver, no internet in CI).
5. [ ] yt-dlp argv snapshot (S4); output name is engine-generated.
6. [ ] ffmpeg/ffprobe argv always carry `-format_whitelist` for the detected type and
       `-protocol_whitelist file,pipe`; concat/HLS disguised as `.mp4` rejected (S5).
7. [ ] Type sniffing: SVG disguised as PNG rejected; HTML rejected; images re-encoded (S6).
8. [ ] Folder ingest copies files; a symlink pointing out of the folder is not followed (S2).

### C. Stages

9. [ ] Ingest local `talking-head-20s.mp4`: proxy (libx264 args snapshot), audio, thumbs, peaks, metadata,
       `addMedia`, idempotent rerun; `{ proxies: false }` produces no proxy/thumbs/peaks; a `.pdf` fixture
       becomes text through `doctext.py`.
10. [ ] Transcribe (slow test): words with timestamps on the fixture; language detected; cached. Commit
        the result as `packages/engine/test/fixtures/transcripts/talking-head-20s.json` (R7), so later
        phases (05 offline project, 11, 12) never need mlx-whisper in CI.
11. [ ] MediaPipe check first: the full-range `.tflite` loads in the pinned MediaPipe Tasks version and
        detects both faces on `face-2people.mp4`. If it does not, use the short-range model and log D-NN.
12. [ ] Facetrack: `face-2people.mp4` picks the largest; `faceIndex` override; keyframes smoothed.
13. [ ] `vox doctor` lists every tool with version and a fix line when missing; warns on node-only yt-dlp.
        `vox doctor <project>` reports caption-override orphans; `vox doctor <project> --unlock` removes a
        lock (the only way to clear another host's lock). The first `vox doctor` run asks once for a
        contact (email or URL) for the Wikimedia Commons User-Agent and saves it as `contact` with
        `writeConfig` (`--json` and non-TTY runs skip the prompt and report it as missing).
14. [ ] Network stages retry 3× with backoff; ingest error hint suggests a local path when yt-dlp fails.

### D. Manual

15. [ ] MANUAL STEP (owner, optional — does not block merge; required later at GATE 2): `vox ingest` one
        real YouTube URL.

## Verify

```bash
pnpm -C packages/engine test
pnpm -C packages/engine test:slow -- stages
uv run --project py pytest
pnpm -C packages/cli exec vox doctor --json
```

## Done when

- [ ] S2–S6, S17 and S19 tests pass; security review clean of CRITICAL/HIGH.
- [ ] Fixture ingest → transcribe → facetrack works by CLI, cached on rerun.
- [ ] `vox doctor` passes on the M5 (provisional; engine done-when #2 is owned by 05 and checked at GATE 2).
- [ ] R5 rows for mlx-whisper model revision and MediaPipe model are filled.

## Risks and fallback

| Risk | Fallback |
|---|---|
| yt-dlp YouTube extraction needs a newer `yt-dlp-ejs` | `vox doctor` offers `yt-dlp -U`; record the version that worked |
| Proxy breaks yt-dlp HTTPS (CONNECT) | Implement CONNECT tunnelling with the IP check before connect; test against a local TLS server |
| mlx-whisper model download size surprises users | Size shown before download (app shows it in phase 09) |

## Handoff notes

- Phase 05 adds `assets.*` and `render`/export jobs on the same runner.
- Phase 05 reads `contact` with `readConfig()` for the Commons User-Agent.
- Phase 11 stores provider entries through `readConfig`/`writeConfig` and registers key values with
  `engine.redactor.addSecrets`; it adds no second config writer or redactor.
- Phase 15 calls `ingest({ proxies: false })` for reference videos.
