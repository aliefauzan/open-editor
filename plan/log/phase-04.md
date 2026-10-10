# Phase 04 — Engine: jobs, Python bridge, ingest, transcribe, facetrack

Status: not started; early steps done under D-19

## Early steps (D-19) — e1-net-sources

Branch `early/e1-net-sources` (worktree `.worktrees/early-e1-net-sources`), pushed; **not merged**:
waits for phase 02 (merge after 02, shim swap). Commits 1017749, 972662c.

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

**Left for phase 04**
- Shim swap: `errors.pending.ts` → `../errors.ts` imports in the 5 src + 3 test files, delete the
  shim, append the codes above.
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
- **Branch**: `early/e2-config-jobs` at 4bee254, pushed; worktree kept. Merge state: ready, waiting
  for 02 (shim swap, then merge).

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
- **Branch**: `early/e4-shots-facetrack` at a6a3b55 (main merged in, incl. P1), pushed; worktree kept.
  Merge state: ready, waiting for 02 (merge after 02).
