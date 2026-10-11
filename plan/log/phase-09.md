# Phase 09 — App: first-run setup + `.dmg`

Status: in progress (started 2026-10-11 15:07), branch `phase/09-app-setup-dmg`, worktree `.worktrees/phase-09`

## Plan (phase run)
Token-budget run: one agent, no subagents; the step-7 review is a self-review (token budget).
1. Engine: resource dirs for packaged builds (data, vox runtime, node module base) + `vox doctor`
   lock-hash check; CLI `self-test --json`, `--version`, resource lookup when bundled.
2. Setup wiring in the engine host: `setup.status/install/updateYtDlp`, `setup.progress`, Chrome
   delegate (bundled HyperFrames CLI), `<tools>/bin` links, launch-time py-env resync, doctor →
   "Ready", update check on launch (repo `aliefauzan/open-editor`).
3. Setup screen + doctor view + update banner (renderer); menu "Install `vox` command".
4. Packaging: CLI + engine-host bundles, resources (R1 table), bundled uv (pinned, verified),
   fuses (S27), drop default_app.asar, size.
5. Slow tests: packaging (self-test, fuses, S31 bundle hash), clean-install (quarantine, spctl,
   ffmpeg-missing view, fake brew + fixture components → Ready), install-command.
6. README install + clone sections; review; verify; log; merge.
Test order: setup handlers → stage table → doctor lock hash → self-test → install-command →
renderer setup view → packaging → clean-install.

## Early steps (D-19) — s1-setup-modules
Branch `early/s1-setup-modules`. Pure Node modules in `apps/desktop/src/engine-host/setup/`, no Electron, no engine imports (own `SetupError`; map `code` to `VoxError` when wiring).

**Steps covered (phase 09 step ids):** 1 (tests for S16 hash refusal, D-12 lock-hash resync, missing tool disables only its stages, repair of one component, progress events, ffmpeg-missing view and "Check again" with fake brew, no ffmpeg download path), 2 (installers against local fixtures + `live.slow.test.ts`), 6 (update check with a Releases-shaped response; the fixture is hand-written to GitHub's documented shape, no release exists yet to record).

**Files:** `manifest.json/.ts` (pins), `http.ts` (https-only policy, loopback http for tests, per-hop redirect check), `download.ts` (temp + size + SHA-256 of received and on-disk bytes, idle timeout, atomic rename), `extract.ts` (`/usr/bin/tar`; full listing checked: only files/dirs, no `..`/absolute, entry cap; archive re-hashed before unpack), `install.ts` (staging + swap, `sweepStale`, per-component lock), `lock.ts`, `run.ts` (spawn arrays, own process group, SIGKILL group on abort), `pyenv.ts` (`uv sync --frozen --no-editable --project <py>`, `.vox-lock-hash`, `doctorPyEnv`, env stripped of UV_*INDEX/PIP_*/PYTHON*, `UV_NO_CONFIG=1`), `ffmpeg.ts` (`brew --prefix ffmpeg`, display-only commands), `ytdlp.ts` (`-U`, `--list-impersonate-targets` parse), `update.ts`, `stages.ts`, `setup.ts` (`getSetupStatus`, `installAll`, `repairComponent`, `resolveUv`), `index.ts`. Tests: `apps/desktop/test/setup/*.test.ts` (86 fast, 2 slow live). Root `tsconfig.json` includes the two folders.

**Numbers:** 86 fast tests green offline (~5 s); full `pnpm test` 1994 passed; live run (VOX_SLOW=1) installed real uv 0.11.19, deno 2.9.5 and yt-dlp 2026.08.19 from the pins; the official yt-dlp macOS binary reports many `--impersonate` targets (supported). Self-review only (owner asked to cut token cost); an earlier typescript + security review pass fixed: stream-locked cancel bug, truncated tar listing, abort leaving orphan children, concurrent install races, short writes, update URL trust.

**Choices (no D-NN needed):** ffmpeg-missing shows both commands only when Homebrew is also missing, else just `brew install ffmpeg`. A Finder-launched app has a minimal PATH, so `/opt/homebrew/bin` is searched after PATH unless `VOX_NO_BREW_FALLBACK=1` (the clean-install test must set it). yt-dlp is not hash-pinned (R5: latest at install): the binary is checked against the release's own `SHA2-256SUMS` (integrity, not authenticity); `yt-dlp-ejs` is bundled in the official binary. Sync uses the exact spec argv, so the dev dependency group is also installed; 09 may add `--no-dev` in `syncArgs`. Py env counts as ready only if the lock hash matches and `<py-env>/bin/python` resolves (fixture uv in 09 tests must create it).

**LEFT for phase 09:** setup screen UI, IPC (`window.vox.setup.*`, `setup.progress`), Chrome delegate (HyperFrames CLI via Electron-as-Node; `setup.ts` takes a `delegates.chrome`), bundling uv into `<resources>/bin/uv` (build script can reuse `manifest.json` pins + `downloadVerified`), `vox doctor` hookup (`doctorPyEnv`, `detectFfmpeg`, `checkImpersonation`), launch-time `ensurePyEnv`, update banner wiring (repo `aliefauzan/open-editor`), stage-id table reconciliation (`stages.ts` is provisional), packaging/fuses/self-test/clean-install tests, README.
