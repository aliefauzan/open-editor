# R4 — Security invariants and the tests that prove them

Every invariant here must have an automated test in the listed phase. The security review in that
phase checks this table, not general impressions. Sources: overview "Security summary" and the
sections named per row.

## Canary key

Tests use one fake key everywhere: `sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000`.
Redaction tests assert this string never appears in outputs. Real keys never appear in tests or fixtures.

## Invariants

| # | Invariant | Spec § | Test (phase) |
|---|---|---|---|
| S1 | Project paths: decode once; reject NUL, absolute, any `..`; `realpath`; accept only under `realpath(projectDir) + sep` | engine "Project folder" | `..`, `%2e%2e`, absolute, NUL, symlink escape rejected (02); same tests through `vox-media://` (08) |
| S2 | Ingested folders are copied, never symlinked | engine "Project folder" | ingest a folder containing a symlink out → copy has no link (04) |
| S3 | yt-dlp connects only through the local filtering proxy; proxy refuses private, loopback, link-local, multicast; connects to the IP it checked | engine "Ingest hardening" | private IP host, redirect to private IP, DNS name → 127.0.0.1 all refused (04) |
| S4 | yt-dlp flags `--ignore-config --no-plugin-dirs --no-playlist --playlist-items 1 --max-filesize 4G -f "bv*+ba/b" -S "res:1080"` (`--playlist` drops the two playlist flags); output name engine-generated | engine "Ingest hardening" | argv snapshot test, default and `--playlist` (04) |
| S5 | ffmpeg/ffprobe on untrusted files use `-format_whitelist` + `-protocol_whitelist file,pipe` | engine "Ingest hardening" | concat/HLS disguised as `.mp4` rejected (04) |
| S6 | Media type from content, not extension; SVG/HTML never accepted as media; images re-encoded | engine "Ingest hardening" | SVG disguised as PNG rejected (04) |
| S7 | Archive licences: only CC0, PDM, BY, BY-SA; ND refuses cutout; BY-SA warns | engine "Archive assets" | filter + cutout refusal tests (05) |
| S8 | Compile hooks (`build.mjs`) run only for templates whose declaring style is `trusted: true` | styles "Compile hook" | untrusted style's own template with a hook → `HOOK_UNTRUSTED`; a trusted parent's template used through an untrusted child runs its hook (03); `migrate` in an untrusted style → `HOOK_UNTRUSTED` (06); draft extracted style (15, `packages/engine/test/styles/extract-untrusted-hook.test.ts`) |
| S9 | Templates have no network at render; fonts/assets local; runtime + GSAP vendored | styles "Template rules"; engine "Compile" | build has no `http(s)` references; lint passes (03, 07) |
| S10 | Renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, `nodeIntegrationInSubFrames: false`, `webSecurity`; navigation and `window.open` denied | app "Window security" | main-process tests: `webPreferences` flags asserted on every window; navigation and `window.open` denied; external links open only for allowlisted hosts (08) |
| S11 | Every IPC handler checks sender = main frame of a `vox-app://` window; args validated by zod | app "Window security" | call from subframe / other origin rejected; bad args rejected (08) |
| S12 | Renderers have no `http(s)` network | app "Window security" | renderer fetch blocked (08) |
| S13 | `vox-media://` HTML has CSP with `connect-src 'none'`, `frame-ancestors vox-app:`; non-media gets `attachment` + `nosniff`; range requests work | app "Untrusted HTML" | header tests (08) |
| S14 | Player runs `sandbox-origin="opaque"` (or the GATE 1 fallback); a template cannot reach `parent.vox`, `window.top.location` or the network | app "Untrusted HTML" | hostile template fixture gets nothing (08) |
| S15 | Permission requests (camera, mic, geolocation, notifications) denied | app "Window security" | handler test (08) |
| S16 | First-run tools pinned + SHA-256 checked (yt-dlp self-verifies) | app "First-run setup" | hash mismatch refused (09) |
| S17 | Keys stored as `keychain:<providerId>` or `env:NAME`; `config.json` mode `0600`; `baseUrl` with credentials rejected | agent "Configuration and keys" | `0600` from the first write by the engine config module (04); key refs and `baseUrl` (11) |
| S18 | Keys read only in the engine host; renderer sees masked keys; masked/absent key on save = unchanged | agent "Configuration and keys"; app "Settings" | settings IPC tests (11, 13) |
| S19 | Redactor covers run records, logs, UI events, `VoxError.cause`, every `APICallError` field | agent "Secret redactor" | patterns + registered values removed from `VoxError.cause` (04); canary never appears, incl. forced `APICallError` (11) |
| S20 | Agent `ingest` only for sources verbatim in the user's messages/attachments; others pause for approval | agent "Untrusted content" | unlisted source pauses run (11); mock injection test in CI: a scripted model that obeys the injection hits an `approval` pause, nothing is ingested, `undoRun` restores the removals (12); live injection eval as extra evidence (12) |
| S21 | Untrusted text wrapped in `<data source>`; `<data`/`</data` inside escaped | agent "Untrusted content" | envelope escaping test (11) |
| S22 | Agent has no shell, file-write or HTTP tool; write tools cannot delete media files or projects | agent "Tools" | `removeMedia` leaves the file on disk (02); tool list snapshot (11) |
| S23 | Budget and step caps per run; `maxOutputTokens` always set | agent "Cost tracking" | upper-bound pause test (11) |
| S24 | `undo_my_last_edit` touches only the current run's entries | agent "Tools" | cannot undo a user edit (11) |
| S25 | Cross-process lock never broken for another host | engine "Write order" | lock from other host → `LOCKED` (02) |
| S26 | Spawned processes get argument arrays, never a shell | R3 | lint rule / grep check in CI (00) |
| S27 | Electron fuses: `RunAsNode` on (CLI needs it), `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` on | app "Packaging and sharing" | read fuses back from the built app (09) |
| S28 | `vox-app://` responses carry the app CSP incl. `frame-ancestors 'none'` | app "Window security" | header test (08) |
| S29 | Engine downloads (archive fetch, images) use the in-process private-address check, incl. after redirects | engine "Ingest hardening" | archive URL resolving to a private address, or redirecting to one, refused (05) |
| S30 | Keys never appear in any spawned process's arguments; Keychain writes use `security -i` with the command on stdin | agent "Configuration and keys" | spawn spy: canary absent from every argv (11) |
| S31 | Nothing writes into the app bundle after install (uv env, caches, tools live in the tools folder) | app "Packaging and sharing" | hash the `.app`, run setup + compile, hash again → unchanged (09) |
| S32 | Exports go only to a user-chosen target: the renderer sends a `targetId` from `exports.chooseTarget` (native dialog in main), never a raw path; the agent has no render/export tool and no output-path argument; writes are temp + rename, never a silent replace | engine "Export targets"; app "Engine-host API" | target tests: existing file → `EXPORT_PATH`, `--overwrite` replaces, temp cleaned on cancel (05); raw path in `jobs.start` rejected, unknown or reused `targetId` rejected, `reveal` only for allow-listed paths (10b); tool-list snapshot (11) |
| S33 | yt-dlp gets `--cookies-from-browser` only when the user set `ingest.cookiesFromBrowser` (Settings or `vox config set`); never from a URL, project file or the agent | engine "Ingest sources" | argv snapshot with and without the setting; a project file or agent call cannot set it (04); Settings toggle and config write spy (13) |
| S34 | Text inside images (frames, archive images, thumbnails) is untrusted content: the vision prompt says it is content to describe, never instructions; a `vision` description returned to the `editor` is wrapped in `<data source="vision">` (D-15) | agent "Untrusted content and threat model" | vision description and the injected view's caption text arrive inside `<data>` (11); mock injection image case: a fixture frame and an archive image whose text orders removals and an `~/.ssh` ingest → no unrequested removal, no un-approved ingest without a pause (12); live injection eval image case as extra evidence (12) |
| S35 | A tool reached through `call_tool` runs under the same rules as a direct one (zod schema, actor `agent`, `runId`, `ingest` source rule, budget); a question turn gets read tools only (D-15) | agent "Tool surface", "Free-form edit" | `call_tool` validation and rule tests, `ingest` through `call_tool` pauses for approval, non-read tool refused in a question turn (11, 12) |
| S36 | A project with `schemaVersion` above the supported one is never written (`SCHEMA_TOO_NEW`); a load-time migration first writes `snapshots/auto-pre-migrate-v<N>.json` (D-15) | engine "Write order, crash recovery, locking" | newer `schemaVersion` refused (no lock, no recovery, no log line), `project.json` and `history.jsonl` byte-identical (02); same through the app (10b) |

## Security review phases

The "Security review" column of R6 is the only list of which phases run `security-reviewer` and on
which rows. Phase 13 runs a final pass over all rows before v1.0.
