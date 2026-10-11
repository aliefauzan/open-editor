# Phase 09 — App: first-run setup + `.dmg`

| Field | Value |
|---|---|
| Status | done (optional MANUAL STEPS 7 and 9b open; they do not block merge) |
| Started · Finished | 2026-10-11 15:07 · 2026-10-11 17:25 |
| Model | Opus 5.5 · token-budget run (one agent, no subagents) |
| Machine | Apple M5, macOS 27.0.1 |
| Branch | phase/09-app-setup-dmg |

## Pre-check
Prerequisites 05 and 08 are [x] in PROGRESS. The early steps (D-19, `early/s1-setup-modules`, below) were merged. Electron 44.7.0, electron-builder 26.15.3, pnpm 12, uv 0.11.19 (pinned).

## Plan summary
1. Engine: resource dirs for packaged builds (data, vox runtime, node module base, py project), `vox doctor` lock-hash check; CLI `self-test --json` and resource lookup when bundled.
2. Engine host: `setup.status/install/updateYtDlp`, `setup.progress`, Chrome delegate (bundled HyperFrames CLI), `<tools>/bin` links, launch-time py-env resync, background doctor, "Ready", update check on launch.
3. Renderer: setup screen, doctor view, update banner. Main: menu "Install vox Command…".
4. Packaging: staged Resources (R1 table), bundled CLI, pinned uv, fuses (S27), no default_app.asar.
5. Slow tests: packaging (self-test, fuses, install link, S31) and clean-install (D-16).
6. README, self-review, verify, log, merge.
Test order: setup handlers → stage table → doctor lock hash → self-test → install command → setup view → packaging → clean-install.

## Checklist
- [x] 1 setup tests (early steps, D-19) + app-setup tests (status, doctor, Ready)
- [x] 2 installers (early steps) + `<tools>/bin` links, Chrome delegate
- [x] 3 setup screen, doctor view, ffmpeg-missing view with copy commands, "Check again"
- [x] 4 packaging: Resources staged, CLI bundle, uv pinned and hash-checked (S16), fuses (S27)
- [x] 5 `vox self-test --json` on the built app
- [x] 6 update check (early steps; fixture in GitHub's documented Releases shape)
- [x] 7 "Install vox command": `~/.local/bin` target tested under a temp HOME; `/usr/local/bin` = MANUAL STEP (optional)
- [x] 8 README install + Homebrew/ffmpeg + clone sections
- [x] 9 clean-install test (D-16)
- [ ] 9b MANUAL STEP (optional): Gatekeeper "Open Anyway" screenshots

## Files created / changed
- Engine: `packages/engine/src/resources.ts` (new: `setResourceDirs`, `dataDir`, `runtimeDir`, `moduleRequire`, `pyProjectDir`), `api.ts`, `py.ts`, `doctor.ts` (python-env-lock check), `geo/search.ts`, `compile/write.ts`, `render/layers.ts`, `styles/validate-dom.ts`; tests `resources.test.ts`, `doctor.test.ts`.
- CLI: `packages/cli/src/self-test.ts` (new), `main.ts` (`self-test`, `resources` in Io), `package.json` exports; `test/self-test.test.ts`.
- Engine host: `index.ts`, `handlers.ts`, `app-setup.ts` (new), `packaged.ts` (new), `setup/bins.ts` and `setup/chrome.ts` (new), `setup/manifest.ts` (JSON import), `setup/pyenv.ts` (`--compile-bytecode`), `setup/stages.ts`.
- Main: `index.ts` (menu, app version, resources), `install-cli.ts` (new), `host.ts`. Shared: `api.ts`, `app-info.ts` (new).
- Renderer: `Setup.tsx`, `setup-store.ts` (new), `App.tsx`.
- Build: `src/cli/vox.ts` (new), `scripts/stage-resources.ts` (new), `scripts/build.ts`, `scripts/after-pack.cjs` (new), `electron-builder.yml`, `package.json`; root `package.json` (`dev`, `dist`), `.gitignore`, `.prettierignore`, `eslint.config.js`.
- Tests: `test/packaging.slow.test.ts`, `test/clean-install.slow.test.ts`, `test/helpers/packaged.ts` (new), `test/main/install-cli.test.ts`, `test/helpers/app.ts`, `test/setup/*`.
- Docs: `README.md`; evidence `docs/evidence/phase-09/` (clean-install.txt, bundle-unchanged.txt, setup-ffmpeg-missing.png, setup-ready.png).

## Verify results
Run after `git merge main` (11b), on the merged branch.

| Command | Result | Numbers |
|---|---|---|
| `pnpm typecheck` | pass | 0 errors |
| `pnpm lint` (eslint + prettier) | pass | clean |
| `pnpm test` | pass | 154 files, 2103 passed, 1 skipped (first run: `framing-provider.local` failed once under load, passed alone and on rerun; `geo/search` hygiene test updated for the `resources.ts` import) |
| `pnpm dist` | pass | `Vox-Studio-0.0.0-arm64.dmg` 189,359,198 bytes (180.6 MB, bar 300 MB); `.app` ~496 MB |
| `pnpm -C apps/desktop test:slow` (VOX_SLOW, sequential) | pass | 6 files, 29 tests (packaging 5, clean-install 3, security, engine-host, setup live), 129.7 s |
| clean-install alone | pass | 3/3, 70.6 s; doctor warning for deno gone (`<tools>/bin` on PATH) |
| `pnpm -C apps/desktop e2e` | pass | 1 passed |
| engine slow (render/layers, styles/*, compile contract + caption-preset, export/render) | pass | 15 files, 195 tests |

One earlier full slow run failed "setup reaches Ready" (doctor still running at 420 s) while an orphaned app from an earlier aborted run was alive; after killing it, the test passed alone (70.6 s) and in the full run. The failure probe now also records the processes still running under the temp folder.

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | `.dmg` < 300 MB; clean-install test passes (quarantine, `spctl` recorded, ffmpeg-missing view, Ready with fixture components) | `.dmg` 180.6 MB; `clean-install.slow.test.ts` 3/3; `docs/evidence/phase-09/clean-install.txt`, `setup-ffmpeg-missing.png`, `setup-ready.png` |
| 2 | S16, S27, S31 pass; `vox self-test --json` passes on the built app; review clean of CRITICAL/HIGH | S16: setup hash tests + bundled uv hash-checked at build; S27: fuses test; S31: `bundle-unchanged.txt` (0 changed); self-test test; self-review below |
| 3 | README covers `.dmg` install (both Gatekeeper routes), Homebrew + ffmpeg, clone path | `README.md` "Install from the .dmg", "Homebrew and ffmpeg", "Development" |

## Review findings
Self-review (token budget): no subagents; one pass with a security focus over the branch diff.

| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| self | MEDIUM | The packaged app accepts `--remote-debugging-port` (a Chromium switch, not the Node inspect fuse). It is local, same-user only; any process that can launch the app as the user can already read its data. Tests use it to drive the app (inspect fuse is off). | accepted, noted |
| self | LOW | `<tools>/bin` is first on the engine host PATH. It sits inside the user-writable tools folder, the same trust as the tool binaries themselves. | accepted |
| self | LOW | The `/usr/local/bin` install runs one admin shell command via osascript; both paths are single-quoted with `'` escaped (unit test). | ok |
| self | — | Bundled uv is the manifest pin, SHA-256 checked at build (S16); update link goes through the openExternal allowlist; update check is https-only. | ok |
| self | — | No secrets, personal paths or emails in committed files (evidence paths replaced by `<tmp>`; grep clean). | ok |

No CRITICAL/HIGH findings.

## Deviations
- D-41: packaged resource layout and setup "Ready" rules (resource dirs API, hoisted HyperFrames node_modules copy, manifest bundled as JSON, background doctor, `--compile-bytecode`, `<tools>/bin` PATH prefix, managed Chrome headless shell only, CDP launch in tests).

## MANUAL STEPS
1. (optional, step 7) Test the `/usr/local/bin` target of "Install vox Command…" (admin prompt). Copied to plan/TODO.md.
2. (optional, step 9b) Open the built app once through "Open Anyway" on your own account; take screenshots of the Gatekeeper dialog for the README. Copied to plan/TODO.md.

## Handoff notes
- `pnpm dist` builds `apps/desktop/dist/Vox-Studio-<version>-arm64.dmg` (ad-hoc signed, not notarized). Staged Resources go to `apps/desktop/out-resources/` (git-ignored); downloads are cached in `apps/desktop/cache/`.
- The packaged app has the Node inspect fuse off. Drive it with `test/helpers/packaged.ts` `launchPackaged()` (remote debugging port + CDP), not Playwright's Electron launcher.
- Engine code that reads bundled files must go through `packages/engine/src/resources.ts` (`dataDir()`, `runtimeDir()`, `moduleRequire()`, `pyProjectDir()`); `import.meta.url` paths break in the bundle.
- New HyperFrames dependencies are picked up by `layoutModules()` in `scripts/stage-resources.ts`; check `vox self-test --json` on the built app after a bump.
- `VOX_UPDATE_REPO=''` turns the update check off (tests); the default repo is `aliefauzan/open-editor`.
- 10b GATE 5 reruns `pnpm -C apps/desktop test:slow -- clean-install` with the full editor (D-16). The doctor on a fresh tools folder takes ~1 min (Python import check).
- `framing-provider.local.test.ts` failed once in the full `pnpm test` run and passed alone (load-dependent; not touched by this phase).

## Early steps (D-19) — s1-setup-modules
Branch `early/s1-setup-modules`. Pure Node modules in `apps/desktop/src/engine-host/setup/`, no Electron, no engine imports (own `SetupError`; map `code` to `VoxError` when wiring).

**Steps covered (phase 09 step ids):** 1 (tests for S16 hash refusal, D-12 lock-hash resync, missing tool disables only its stages, repair of one component, progress events, ffmpeg-missing view and "Check again" with fake brew, no ffmpeg download path), 2 (installers against local fixtures + `live.slow.test.ts`), 6 (update check with a Releases-shaped response; the fixture is hand-written to GitHub's documented shape, no release exists yet to record).

**Files:** `manifest.json/.ts` (pins), `http.ts` (https-only policy, loopback http for tests, per-hop redirect check), `download.ts` (temp + size + SHA-256 of received and on-disk bytes, idle timeout, atomic rename), `extract.ts` (`/usr/bin/tar`; full listing checked: only files/dirs, no `..`/absolute, entry cap; archive re-hashed before unpack), `install.ts` (staging + swap, `sweepStale`, per-component lock), `lock.ts`, `run.ts` (spawn arrays, own process group, SIGKILL group on abort), `pyenv.ts` (`uv sync --frozen --no-editable --project <py>`, `.vox-lock-hash`, `doctorPyEnv`, env stripped of UV_*INDEX/PIP_*/PYTHON*, `UV_NO_CONFIG=1`), `ffmpeg.ts` (`brew --prefix ffmpeg`, display-only commands), `ytdlp.ts` (`-U`, `--list-impersonate-targets` parse), `update.ts`, `stages.ts`, `setup.ts` (`getSetupStatus`, `installAll`, `repairComponent`, `resolveUv`), `index.ts`. Tests: `apps/desktop/test/setup/*.test.ts` (86 fast, 2 slow live). Root `tsconfig.json` includes the two folders.

**Numbers:** 86 fast tests green offline (~5 s); full `pnpm test` 1994 passed; live run (VOX_SLOW=1) installed real uv 0.11.19, deno 2.9.5 and yt-dlp 2026.08.19 from the pins; the official yt-dlp macOS binary reports many `--impersonate` targets (supported). Self-review only (owner asked to cut token cost); an earlier typescript + security review pass fixed: stream-locked cancel bug, truncated tar listing, abort leaving orphan children, concurrent install races, short writes, update URL trust.

**Choices (no D-NN needed):** ffmpeg-missing shows both commands only when Homebrew is also missing, else just `brew install ffmpeg`. A Finder-launched app has a minimal PATH, so `/opt/homebrew/bin` is searched after PATH unless `VOX_NO_BREW_FALLBACK=1` (the clean-install test must set it). yt-dlp is not hash-pinned (R5: latest at install): the binary is checked against the release's own `SHA2-256SUMS` (integrity, not authenticity); `yt-dlp-ejs` is bundled in the official binary. Sync uses the exact spec argv, so the dev dependency group is also installed; 09 may add `--no-dev` in `syncArgs`. Py env counts as ready only if the lock hash matches and `<py-env>/bin/python` resolves (fixture uv in 09 tests must create it).

**LEFT for phase 09:** setup screen UI, IPC (`window.vox.setup.*`, `setup.progress`), Chrome delegate (HyperFrames CLI via Electron-as-Node; `setup.ts` takes a `delegates.chrome`), bundling uv into `<resources>/bin/uv` (build script can reuse `manifest.json` pins + `downloadVerified`), `vox doctor` hookup (`doctorPyEnv`, `detectFfmpeg`, `checkImpersonation`), launch-time `ensurePyEnv`, update banner wiring (repo `aliefauzan/open-editor`), stage-id table reconciliation (`stages.ts` is provisional), packaging/fuses/self-test/clean-install tests, README.
