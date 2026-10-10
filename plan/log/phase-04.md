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
