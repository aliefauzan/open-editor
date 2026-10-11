# Phase 04 — Engine: jobs, Python bridge, ingest, transcribe, facetrack

Status: [x] done (2026-10-11, single agent, worktree `.worktrees/phase-04`, branch
`phase/04-engine-jobs-ingest-transcribe`)

## Plan (full phase run)

Early packages E1–E4 and P1 did steps 1, 2, 3 (TS + pytest), 4, 5 (argv), 5b (URL table), 6, 7, 8,
9b (measuring), 9c core, 10b, 11, 12 (tool), 12b, 12c. This run wires them in:
1. Tools: `resolveToolPaths` (tools dir, then PATH) → `EngineOptions.tools`; config `projectsDir` in
   CLI; redactor into `EngineLog`, `VoxError` JSON/cause redacted.
2. Jobs on the engine: `engine.jobs` (runner + kinds), `engine.on('job.*')`, job results as one
   `batch` with `{ jobId, baseVersion }` (step 1b tests).
3. yt-dlp: S33 cookies from `readConfig()` only, `--js-runtimes node` when deno is absent, env proxy
   vars stripped, `LOGIN_REQUIRED` mapping, recorded fixtures (format choice, carousel), retry 3×.
4. Ingest stage (local file/folder/URL/doc): copy → sniff → analyse → CFR copy → proxy → audio m4a
   → thumbs sprite → peaks → `addMedia`; cache by input hash; `{ proxies: false }`.
5. Stages `transcribe`, `shots`, `facetrack` (detections + path cache), `mediaFrames`.
6. CLI: `doctor`, `ingest`, `transcribe`, `shots`, `facetrack`, `media-frames`.
7. Commit `transcripts/`, `shots/`, `facetracks/` fixtures for `talking-head-20s`.
Test order: tools/config → jobs 1b → ytdlp → ingest → transcribe/shots/facetrack → doctor → CLI.

Resume notes: none yet.

## Checklist

Early packages (D-19, sections below) did steps 1, 2, 3 (TS + pytest), 4, 5, 5b (URL table), 6, 7, 8,
9b (measuring), 9c core, 10b (Python), 11, 12 (tool), 12b, 12c. This run:
- [x] 1b Job results: one `batch` with `{ jobId, baseVersion }`; conflicting edit → `JOB_CONFLICT`,
      nothing changed; unrelated edit passes (`test/media-jobs.test.ts`).
- [x] 3 Tools dir (`tools.ts`: `<tools>/bin`, else PATH), config `projectsDir` in the CLI, zod ↔ JSON
      Schema agreement for transcribe request/result, doctext result, facetrack request.
- [x] 5/5b yt-dlp download: S33 cookies from config only, `--js-runtimes node` without deno, proxy env
      stripped, `LOGIN_REQUIRED` + hint, 1080×1920 format choice, carousel first item + count.
- [x] 9/9b Ingest stage (file/folder/URL/doc): sniff → analyse → CFR copy → proxy → m4a → thumbs →
      peaks → `addMedia`; cache by content hash; `{ proxies: false }`; mp4/mov/webm, VFR, NTSC.
- [x] 9c `shots` job on `cuts-2shot` (proxy and original at 360p), cached; facetrack subjects equal
      with and without proxies.
- [x] 10 `transcribe` job (cached, `transcriptRev`); seeds committed:
      `test/fixtures/{transcripts,shots,facetracks}/talking-head-20s.json`.
- [x] 10b engine side: speech gate and word kinds through the job (`music-silence`: words only from
      the 12 s sentence; `speech-fillers`: `filler` and `repeat` kinds).
- [x] 12/12c `facetrack` job (face model fetched into `<tools>/models`, SHA checked) and
      `engine.facetrackPath` (cached); `engine.mediaFrames`.
- [x] 13 `vox doctor` (+ `<project>`, `--unlock`, contact prompt once on a TTY).
- [x] 14 Retry 3× (1/2/4 s); yt-dlp failure hint suggests a local file.
- [x] CLI: `ingest`, `transcribe`, `shots`, `facetrack`, `media-frames`, `doctor`.
- [ ] 15 MANUAL STEP (owner, optional): real YouTube / Instagram reel / TikTok ingest (TODO).

## Files created / changed

Engine `src/`: `api.ts` (jobs, redactor, doctor, facetrackPath, mediaFrames), `config.ts` (env arg),
`doctor.ts`, `errors.ts` (`LOGIN_REQUIRED`, redacted cause), `media-api.ts` (job kinds, face model,
mediaFrames, facetrackPath), `net/retry.ts`, `py.ts`, `stages/{ingest,transcribe,ytdlp}.ts`,
`stages/media/{derive,run}.ts`, `stages/shots.ts`, `tools.ts`. CLI `src/main.ts`.
Tests: `test/{doctor,media-api,media-jobs,errors}.test.ts`, `test/stages/{ingest,ytdlp}.test.ts`,
`test/stages/{ingest,media-jobs}.slow.test.ts`, `test/stages/{media-chain,ytdlp}.local.test.ts`,
`test/tools/tools.test.ts`, `test/helpers/{fake-py,fake-ytdlp}.mjs`, `test/py/*`,
`test/fixtures/ytdlp/*` (recorded info JSON + stderr), seeds above; `packages/cli/test/media.test.ts`.

## Verify results

After `git merge main` (2026-10-11 05:35), fixtures from `make.sh`:
- `pnpm -C packages/engine test`: 87 files, 1184 passed (local tier included).
- `pnpm -C packages/engine test:slow -- stages`: 3 files, 11 passed.
- `uv run --project py pytest`: 109 passed.
- `pnpm -C packages/cli exec vox doctor --json`: exit 0, `ok: true`, 15 checks; warnings only:
  `yt-dlp-impersonate` (curl_cffi 0.16.3 "unsupported" on the M5), `model-face` (not downloaded yet in
  the default tools dir; first facetrack fetches it), `contact` (not set).
- Root `pnpm test`: 111 files, 1642 passed, 1 skipped. `pnpm lint` and `pnpm typecheck` clean.

## Done when

- [x] S2–S6, S17, S19, S33 tests pass; self-review found no CRITICAL/HIGH.
- [x] Sources tests: URL classes, `LOGIN_REQUIRED`, 1080×1920 choice, carousel first item.
- [x] CLI chain on `talking-head-20s.mp4` (scratch `VOX_HOME` and tools dir): `vox ingest` → `shots` →
      `transcribe` → `facetrack`, one history entry each (actor `cli`); rerun prints reused/cached and
      adds no entry; `media-frames` gives 2 PNGs. `JOB_CONFLICT` in `media-jobs.test.ts`.
- [x] VFR + CFR copy, loudness, speech gate, word kinds, shots, facetrack path tests pass.
- [x] `vox doctor` passes on the M5 (provisional; warnings above).
- [x] R5 rows (mlx-whisper revision, MediaPipe model, onnxruntime, Silero SHA-256, pyobjc Vision)
      filled (P1).

## Review findings

Self-review (owner asked to cut token cost), R6 focus (code, python, silent failures) and security
(S2–S6, S17, S19, S33). No CRITICAL/HIGH. Fixed MEDIUM: `doctor --unlock` reported `removed: true`
when unlink failed (now only ENOENT is ignored); a facetrack path cache file with a wrong shape was
returned (now rebuilt). Checked: media paths come from `relPath()` in the schema; ffmpeg argv keep
format/protocol whitelists (`frameArgs`); cookies only from config; job errors and `VoxError.cause`
redacted (canary test); face model download through `fetchPublic` with size cap and SHA.

## Deviations

- Implementation choices recorded as D-31. New error code this run: `LOGIN_REQUIRED` (R2 already
  lists it); `MEDIA_BOUNDS`, `TOOL_FAILED`, `NET_DNS`, `PY_TOOL_FAILED` came from earlier packages.
- `pnpm -C packages/engine test -- <file> -t <name>` treats the `-t` value as a path filter; run
  `npx vitest run <file> -t <name>` for one test.

## MANUAL STEPS

- Step 15 (optional, does not block merge; needed at GATE 2): added to TODO "Manual steps".

## Handoff notes

- Job kinds on `engine.jobs`: `ingest`, `transcribe` (gpu), `shots`, `facetrack`; args strict, optional
  `actor` (default `user`). Results apply as one `batch` with `jobId`.
- Seeds for later phases: `packages/engine/test/fixtures/{transcripts,shots,facetracks}/talking-head-20s.json`
  (media hash of the checked-in mp4); regenerate with `VOX_WRITE_SEEDS=1` on `media-chain.local`.
- Phase 05: `engine.facetrackPath(projectId, mediaId, opts)` is ready for the compile path provider;
  `readConfig(env)` gives `contact`. Phase 09: the face model lands in `<tools>/models` on first
  facetrack; Whisper uses `<tools>/models/whisper-large-v3-turbo` when present, else the HF cache.
- Phase 11: use `engine.redactor.addSecrets` and `readConfig`/`writeConfig` (env-aware).

## Early steps (D-19) — e1-net-sources

Branch `early/e1-net-sources`, pushed; **merged** into main as 02cf19b (2026-10-11, after 02 at
5d89ddd). Commits 1017749, 972662c, shim swap 928dc27; worktree removed.

**Steps done**: 4 (proxy, S3), 5 argv part (S4; S33 argv part only), 5b classify part (D-13 URL
table), plus the S29 core for phase 05 (in-process checked fetch).

**Files**
- `packages/engine/src/errors.pending.ts`: temporary `VoxError` shim (D-19), byte-identical copy.
- `packages/engine/src/net/address.ts`: `isBlockedAddress(ip)` (IPv4 + IPv6 special ranges incl.
  TEST-NETs, CGNAT, benchmarking, reserved; IPv4-mapped, SIIT, 6to4, NAT64 (both prefixes), Teredo;
  zone ids and non-IPs fail closed), `normaliseHost`, `resolvePublic(host, resolver)` (resolves once,
  refuses if **any** answer is blocked, returns the checked address), `systemResolver`, `Resolver` type.
- `packages/engine/src/net/proxy.ts`: `startFilteringProxy({ resolver, dial, onRefused,
  connectTimeoutMs, idleTimeoutMs, maxConnections })` → `{ url, port, close }` on 127.0.0.1:0.
  CONNECT tunnelling and absolute-form plain HTTP; resolves each host once, connects to the checked
  IP; refusals answer 403 (`NET_BLOCKED`), 400 (`URL_INVALID`, origin-form, non-http, bad
  authority/port) or 502 (`NET_DNS`, upstream failure) with an `X-Vox-Refused` header and an
  `onRefused({ host, port, code, address? })` callback. Hop-by-hop headers stripped. `dial` is a test
  seam (always gets an already-checked address; identity in production).
- `packages/engine/src/net/fetch.ts`: `fetchPublic(url, { resolver, dial, ca, headers, maxRedirects=5,
  timeoutMs, signal })` → `{ url, status, headers, body }` (body is the response stream) and
  `readBody(res, maxBytes=256 MiB)`. Every hop resolved + checked, socket to the checked IP, TLS with
  SNI/cert check on the URL host; credential headers dropped on cross-origin redirects.
- `packages/engine/src/stages/sources.ts`: `classifyUrl(url)` → `youtube | instagram | tiktok | other |
  invalid`, path-aware (YouTube watch?v=/shorts/live/embed + youtu.be/<id>; Instagram reel(s)/p/tv,
  optionally after a user name; TikTok `@user/video/<id>`, `m.` `/v/<id>.html`, `/t/<code>`, `vm.`/`vt.`
  short links). Exact host lists (look-alike hosts → `other`); channel/profile/playlist pages → `other`.
- `packages/engine/src/stages/ytdlpArgs.ts`: `buildYtdlpArgs({ url, proxyUrl, outDir, outputId,
  playlist?, cookiesFromBrowser?, jsRuntime? })`. Spec flags in spec order, `--proxy`, `-o
  <outDir>/<outputId>.%(ext)s` (with `--playlist`: `<outputId>-%(playlist_index)s.%(ext)s`), optional
  `--js-runtimes node`, optional `--cookies-from-browser safari|chrome|firefox`, then `--` and the
  parsed, normalised URL. Validates: http(s) URL (`URL_INVALID`), proxy must be
  `http://127.0.0.1:<port>`, absolute `outDir` without `%`, safe `outputId`, browser enum
  (`VALIDATION`).
- Tests: `packages/engine/test/net/{address,proxy,fetch}.test.ts`, `test/net/servers.ts` (local
  HTTP/TLS servers; self-signed cert for `public.test` made with `openssl` at test time),
  `test/stages/{sources,ytdlpArgs}.test.ts`.

**Tests**: address 69, proxy 15, fetch 11, sources 51, ytdlpArgs 10 (156 new). Root `pnpm typecheck`,
`pnpm lint`, `pnpm test` (193 passed) and `uv run --project py pytest` (4 passed) green; net tests
re-run 3× with no flake. No internet used: a fake resolver maps names to a public IP and `dial` maps
that IP to a local server, so the real address check runs unchanged.

**New error codes** (append to `ERROR_CODES` in `errors.ts` at the shim swap): `URL_INVALID`,
`NET_BLOCKED`, `NET_DNS`, `NET_REDIRECTS`, `NET_TOO_LARGE`. Existing code used: `VALIDATION`.

**Review**: `ecc:security-reviewer` on S3/S4/S26/S29/S33-argv: no CRITICAL/HIGH. Fixed: MEDIUM
credential headers on cross-origin redirects, MEDIUM checked-vs-passed URL in argv, MEDIUM proxy
idle tunnels / no connection cap, LOW missed special ranges, LOW abort cleanup, LOW plaintext 502
into an open tunnel, LOW malformed `Location`. Not done (left to 04): proxy port allowlist and
per-run proxy auth (spec asks neither; the proxy reaches public addresses only).

**Merge (after 02)**: shim swapped (`../errors.ts` in 4 src + 3 test files, shim deleted), the five
codes appended to `ERROR_CODES`. Verify after merging main: typecheck, lint (prettier) green;
`pnpm test` 961 passed / 1 skipped (one run hit the 30 s timeout in 02's `log.test.ts` rotation
test at load average 22 from parallel agents; it passes in 2 s alone, twice); pytest 109 passed
after `make.sh` (fresh worktree had no generated audio-QA fixtures).

**Left for phase 04**
- S33 config sourcing (`ingest.cookiesFromBrowser` from `readConfig()` only; a URL, project file or
  ingest argument cannot set it) + its tests; `jsRuntime` detection (deno absent → `node`).
- `LOGIN_REQUIRED` mapping from yt-dlp stderr, recorded `fixtures/ytdlp/*` (1080×1920 format choice,
  carousel first item + count), ingest wiring (start proxy per ingest job, pass `proxy.url`, close it
  on finish/cancel; map `onRefused` into the ingest error), retry/backoff (step 14).
- Strip `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` from the yt-dlp spawn env (reviewer note;
  `--proxy` should win, not verified against yt-dlp).
- `api.ts` exports (none added here). Phase 05 uses `fetchPublic` for archive/image downloads (S29
  tests on the archive path).

## Early steps (D-19) — e2-config-jobs

- **Steps done**: 1 (job runner: concurrency, GPU exclusivity, cancel, progress events, `register`),
  2 (config tests S17, redactor tests S19), 3 TS part (bridge tests with a fake tool: schema mismatch,
  progress, stderr tail, `--frozen`/`--no-sync` argv and uv env with a tools dir). Decisions: D-20.
- **Files** (branch `early/e2-config-jobs`): `packages/engine/src/{config,redact,jobs,py}.ts`,
  `src/errors.pending.ts` (D-19 shim, byte-identical copy), tests `packages/engine/test/{config,redact,jobs,py}/`
  (incl. `py/fake-uv.mjs`, `config/write-worker.ts`), test tool `py/vox_py/_echo.py`. Dependency
  `zod` 4.6.5 exact in `packages/engine/package.json` (same pin as 02).
- **Tests**: 81 new vitest tests (config 19, redact 18, jobs 25, py 19), incl. cross-process config
  writes (6 processes x 5 keys), process-group kill on cancel, a real `uv run --frozen ... -m
  vox_py._echo` round trip. Root `pnpm typecheck && pnpm lint && pnpm test`: 118 passed (9 files);
  `uv run --project py pytest`: 4 passed. Run 5x, no flakes.
- **Review**: ecc:typescript-reviewer + ecc:security-reviewer. Fixed all HIGH: lock steal race and
  foreign-lock release (owner token, rename-aside break), `finish()` could leave a job unsettled,
  request serialised after spawn, throwing progress listener, unredacted progress/stored messages,
  config JSON error echoing file text, child env (now an allowlist), orphaned groups on exit. Left
  (MEDIUM/LOW): a handler that ignores its abort signal keeps its slot; finished jobs are never pruned
  (add `forget`/limit when wiring the API); no wall-clock timeout for Python tools; `~/.vox` mode is
  only set on creation; tool names are not allow-listed against a registry.
- **New error codes** (append to `ERROR_CODES` at the shim swap): `CONFIG_INVALID`, `CONFIG_LOCKED`,
  `JOB_FAILED`, `PY_TOOL_FAILED`, `PY_OUTPUT_INVALID`, `TOOL_MISSING`, `CANCELLED`.
- **Left for phase 04**: step 1b (`baseVersion`, one `batch` with `jobId`, `JOB_CONFLICT`; needs 02
  `applyOp`); wire `readConfig().projectsDir` into 02's `resolveProjectsDir` (config input exists) and
  its test; `engine.redactor`, `engine.jobs`, `on()` and `readConfig`/`writeConfig` exports in
  `api.ts`; redact `VoxError.cause` at creation/serialisation after the shim swap; pytest JSON-Schema
  agreement per tool (P1's tools); `ToolPaths` (uv path, tools dir) from `openEngine`.
- **Branch**: `early/e2-config-jobs`, shim swapped to errors.ts after 02; merged to main as 6502042; worktree
  removed (verify: pnpm test 1459 passed / 1 skipped, pytest 109 passed).

## Early steps (D-19) — p1-py-tools

- **Steps done**: 3 pytest part (each tool's request/result checked against hand-written JSON Schemas
  in `py/tests/schemas/`), 10b (`vad.py`: vendored Silero VAD v6.2.3 ONNX through onnxruntime, port of
  `get_speech_timestamps`), 11 (`transcribe.py`: VAD gate, mlx-whisper pinned revision, filler
  `initial_prompt`, segment and word drop rules), 12 `facetrack.py` part (MediaPipe full-range faces
  with tiles, Vision bodies and saliency), 12b (`doctext.py`, pypdf). Pytest marker `local` (skipped
  when `CI` is set; locally a missing fixture fails). Decisions: D-21 (word clipping rule, mediapipe
  1.0.0, tiles, 360p = short side, detections format, tool protocol and error codes, model files).
- **Files** (branch `early/p1-py-tools`): `py/vox_py/{_tool,vad,transcribe,facetrack,doctext}.py`,
  `py/vox_py/models/{silero_vad.onnx,LICENSE.silero,README.md}` (placeholder model removed),
  `py/tests/{conftest,test_tool_protocol,test_vad,test_transcribe,test_facetrack,test_doctext}.py`,
  `py/tests/test_package.py` (wheel ships the real model), `py/tests/schemas/*.json` (10 files),
  `py/tests/data/whisper-recorded.json`, `py/pyproject.toml` + `py/uv.lock` (pins in R5; uv
  environments macOS arm64 only).
- **Tests**: `uv run --project py pytest` with `CI=1`: 51 passed, 7 skipped (the `local` tier).
  Local tier (bench lock): 7 passed in 15 s. Numbers: VAD on `music-silence.wav` = one region
  12002–13950 ms (duration 14066 ms); `speech-fillers.wav` = 6 regions. transcribe on
  `music-silence.wav` = words only from 12002 ms ("This sentence follows the silence."), 4.4 s;
  on `speech-fillers.wav` = all words kept incl. um, uh, the repeat "I think I think", first words
  "The" and "It" (clipped), 3.7 s. facetrack `face-2people.mp4` = 2 faces on 60/60 samples, 2.7 s;
  `cuts-2shot.mp4` = 108 samples (72 with 1 face, 36 with 0), body boxes on the face shots, saliency
  on 106/108, 3.7 s; `podcast-2face.mp4` 2 faces on 144/144, 5.8 s; portrait `phone-vfr` samples at
  360×640. doctext on a PDF made in the test, RC4 encrypted (`DOC_ENCRYPTED`) and AES with an empty
  password (read). Whisper weights first download 1.6 GB in about 92 s (Hugging Face cache).
- **Review**: ecc:python-reviewer. Fixed HIGH: missing `cryptography` (AES PDFs crashed). Fixed MEDIUM:
  C stdio flush before fd 1 is restored, face model download size cap and error mapping, duration
  fallback when ffprobe says N/A, zero decoded frames = `MEDIA_UNREADABLE`, NUL in paths, 2·pad VAD
  split tests. Left (engine side): `transcribe` without `modelPath` downloads at run time (the engine
  should always pass `modelPath`); Whisper `config.json` is not hashed (weights are); default format
  whitelist has no aac/avi/mpegts (the engine passes the detected type); no subprocess timeout in the
  tools (the engine enforces one, see E2); Whisper runs on the full audio with
  `condition_on_previous_text` at its default; a scanned PDF returns empty text (OCR is Part C).
- **Left for phase 04**: engine stages (`transcribe`, `facetrack`, doc import) and `py.ts` wiring (E2)
  with the zod ↔ JSON Schema agreement test per tool; commit `transcripts/talking-head-20s.json`;
  facetrack path builder (E4); where the face model and Whisper weights live (tools dir), their
  download and size prompt (04/09); `vox doctor` model lines; tool timeouts; map tool error codes to
  `PY_TOOL_FAILED`/engine codes; spec/plan text now says the clipping rule (D-21).
- **Branch**: `early/p1-py-tools`, merged into main with `--no-ff` right after this commit and pushed;
  worktree removed.

## Early steps (D-19) — e4-shots-facetrack

- **Steps done**: 9c core (`detectShots`: ffmpeg `scdet=threshold=10` on the proxy, or on the original
  scaled to 360p in the same graph, cut times from `metadata=mode=print` on stdout, contiguous
  `{startMs,endMs}[]` from 0 to `durationMs`), 12c (TS crop path builder on the `vox_py.facetrack`
  detections: shot resets, hysteresis > 30 % for a continuous 1 s, locked/smooth/follow, 10 % dead
  zone, trackSpeed cap, `auto` fallback face → body → saliency → centre, `faceIndex`, user keyframes
  pinned with a 300 ms blend, output `{atMs,x,y,scale}`, cache key). Decisions: D-24.
- **Files** (branch `early/e4-shots-facetrack`): `packages/engine/src/stages/{shots,facetrack}.ts`,
  `src/errors.pending.ts` (D-19 shim, byte-identical copy), tests
  `packages/engine/test/stages/{shots.test,shots.slow.test,facetrack.test,facetrack-schema.test,facetrack.local.test,facetrack-synth}.ts`.
  Dependencies `zod` 4.6.5 and `ajv` 8.20.0 exact in `packages/engine/package.json` (same pins as 02;
  ajv only in the zod ↔ JSON Schema agreement test). Local types mirror spec `frame.*` (no 02 model
  import).
- **Detection format**: aligned with P1 / D-21 (`py/tests/schemas/facetrack.result.json`); no mismatch.
  The zod `DetectionsSchema` and the Python JSON Schema (ajv 2020) agree on 14 good/bad cases.
- **Tests**: 70 new vitest tests: shots 16 fast (argv, parse, real ffmpeg on a generated 3-shot clip,
  `TOOL_MISSING`, `TOOL_FAILED` with stderr tail, abort → `CANCELLED`) + 2 slow (`cuts-2shot.mp4`
  cuts within 1 frame, proxy and 360p path); facetrack 38 (no drift across a cut in every stability,
  hysteresis 0.5 s no switch / 1.5 s switch after 1 s, locked dead zone, trackSpeed, 300 ms blend,
  blends never cross a cut, cache key); schema agreement 14; local 2 on real MediaPipe/Vision
  detections (`cuts-2shot`: face, face, saliency in `auto`; `podcast-2face`: one switch at 8000 ms,
  face B area 1.68× face A). Root `pnpm typecheck` clean, `pnpm test` 268 passed, 1 skipped (14 files).
- **Review**: ecc:typescript-reviewer. Fixed: `trackSpeed`/`stability` read from the prototype chain,
  a challenge interrupted by losing the subject now restarts its 1 s, a lost pinned face is picked
  again by index, repeated sample times (keep last), `Math.min(...spread)` on hour-long shots, pins
  clamped to scale 1..8 and a crop inside the source, `inputsHash` in the cache key. Left (LOW):
  scdet can fire on two adjacent frames (no minimum shot length), a stream `start_time` offset is
  trusted to ffmpeg's normalisation, the blend is linear, the detections schema is parsed per call.
- **Error codes**: uses `VALIDATION` (02), `TOOL_MISSING`, `CANCELLED` (E2) and `TOOL_FAILED` (E3). No
  new codes.
- **Left for phase 04**: switch the local `frame.*` types to 02's model types and the shim to
  `errors.ts`; move the ffmpeg runner onto E3's shared runner (`stages/media/run.ts`); the `shots` job
  kind, writing `shots/<mediaId>.json`, `MediaItem.shotsPath`, reuse on rerun; the facetrack job (P1
  tool via `py.ts`, detections file) and path cache storage under the cache key; CLI `vox shots` /
  `vox facetrack`; ingest with `{proxies:false}` uses the 360p path; offline seeded fixture files.
  For phase 05: the compile path provider (`applyClipFraming` per item → translate + scale).
- **Branch**: `early/e4-shots-facetrack`, shim swapped to errors.ts after 02; merged to main as 560506d; worktree removed.
  Merge state: merged (verify: pnpm test 1032 passed / 1 skipped, pytest 109 passed).

## Early steps (D-19) — e3-media-export

- **Steps done**: 6 (content sniffing, S6: type from the first 4 KiB, text heads never media,
  `MEDIA_UNSUPPORTED` with what was found and the accepted types), 7 (S5 argv: `-protocol_whitelist
  file,pipe`, per-type `-format_whitelist`, forced `-f`, MOV drefs pinned off, `V` stream selectors;
  shared child runner with AbortSignal, timeout, stderr tail, redact hook), 8 (S2 safe copy: folder
  walk without following links, bounded; O_NOFOLLOW source, `within` check, no-replace temp + move,
  SHA-256), measuring part of 9b (probe, D-15 VFR rule, fixed-set snapping incl. the GATE 1 integer
  fallback, ebur128 loudness; proxy 540p and CFR copy argv). Decision: D-25.
- **Files** (branch `early/e3-media-export`): `packages/engine/src/stages/media/{sniff,ffargs,run,copy,analyze,proxy}.ts`,
  `src/fs/no-replace.ts`, `src/errors.pending.ts` (D-19 shim, byte-identical copy), tests
  `packages/engine/test/media/{sniff,ffargs,run,copy,analyze,proxy}.test.ts`, `analyze.slow.test.ts`,
  `helpers.ts`. No new dependencies.
- **Tests**: 166 new fast tests (sniff 50, ffargs 20, run 11, copy 15, analyze 50, proxy 20 with a
  cover-art mp4) + 5 slow (`phone-vfr-20s.mp4` VFR at 30000/1001, CFR copy pts spread < 0.5 ms, proxy
  540×960; `ntsc-2997-20s.mp4` 30000/1001 with no copy, integer-only copy at 30/1; talking-head proxy
  960×540, keyframes 0.5 s apart). Hostile files are generated in temp folders (make.sh untouched).
  Root `pnpm typecheck` and `pnpm lint` clean, `pnpm test` 242 passed (12 files), `VOX_SLOW=1` media 5
  passed, `uv run --project py pytest` 4 passed.
- **Review**: security (S2/S5/S6/S32) and TypeScript reviewers, no CRITICAL. Fixed: text polyglots with
  a media signature (`<!--ftyp…`, `<!--free…`) were sniffed as MOV; cover art taken for the video
  (`v:0` → `V:0`); no ffprobe timeout; unbounded folder walk and copy size; half-written copy on a hard
  kill; `inputsAreWhitelisted` accepted any whitelist and no `-f`; flaky pgrep/sleep tests (now pid via
  `onSpawn` and polling); throwing redactor; ANSI escapes in the stderr tail. Left (LOW): keyframe
  rounding at 25 fps (13 = 0.52 s), SAR ignored in proxy size, metadata kept on the CFR copy, hard
  links with nlink > 1 copied, strict r = avg compare (spec), non-integer rotation, PATH-resolved tool
  binaries until phase 04 passes the tools folder, child env not reduced.
- **Error codes** (new, in the shim): `MEDIA_UNSUPPORTED`, `TOOL_MISSING`, `TOOL_FAILED`, `CANCELLED`
  (same meaning as E2), `EXPORT_PATH` (phase 05). Also uses `VALIDATION`, `NOT_FOUND`, `PATH_INVALID`.
- **Left for phase 04**: shim → `errors.ts`; `addMedia` / ingest wiring (sniff and analyse the engine's
  copy in `media/`, never the user's path; sweep `.vox-part-*`), cache keys, jobs and CLI flags; write
  the proxy / CFR copy / image re-encode into an O_EXCL temp then move it (rule in `proxy.ts`); pass the
  tools folder and `engine.redactor.redact` to `runTool`; use 02's `model/fps.ts` and model types in
  place of the local `Fps`; audio m4a, thumbnails and peaks; E4's shots runner onto `run.ts`.
- **Branch**: `early/e3-media-export`, shim swapped to errors.ts after 02; merged to main as bfcdb3f; worktree
  removed (verify: pnpm test 1238 passed / 1 skipped, pytest 109 passed).
