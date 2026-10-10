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
