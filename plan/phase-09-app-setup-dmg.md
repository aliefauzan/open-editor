# Phase 09 — App: first-run setup + `.dmg`

| Field | Value |
|---|---|
| Track | app |
| Prereq | 05 (GATE 2), 08 |
| Spec § | app "First-run setup", "Packaging and sharing", "Architecture" (install `vox` command), "Testing" (setup, packaging smoke test) |
| Model | Sonnet 5.5 · high |
| Gate | — |
| Next | 10a |

## Goal

Anyone with an Apple Silicon Mac can install the shared `.dmg`, get past Gatekeeper once, and reach a green
"Ready" setup screen. The only terminal step is installing Homebrew + ffmpeg (D-05), shown with copy
buttons. Builders can clone and `pnpm dist` themselves.

## Required reading

- App spec sections above; R4 rows S16, S27, S31; R5 "External tools"; R1 "Packaged app (phase 09)".
- D-05 (ffmpeg from Homebrew only).
- D-02 (ad-hoc signing, update check).
- D-15 (`onnxruntime` and `pyobjc-framework-Vision` in v1; vendored Silero VAD model).

## Output

- `src/engine-host/setup/` (downloads run in the engine host, which owns the network; main only hosts
  the screen): `manifest.json` (component, version, URL, SHA-256, size, licence), installer with
  progress events (`setup.progress`), repair per component, into
  `~/Library/Application Support/Vox Studio/tools/`:
  - bundled uv → `uv sync --frozen --no-editable` of the bundled `py/` (lockfile) into `<tools>/py-env`
    (`UV_PROJECT_ENVIRONMENT`), cache `<tools>/uv-cache` (`UV_CACHE_DIR`), Python in `<tools>/python`
    (`UV_PYTHON_INSTALL_DIR`); the engine then runs `uv run --frozen --no-sync`; nothing is written into
    the app bundle. After a sync, setup writes the SHA-256 of the bundled `uv.lock` to
    `<tools>/py-env/.vox-lock-hash`; on launch the setup screen and `vox doctor` compare it and re-run the
    sync on a mismatch (an app update that adds Python packages, e.g. 14d; D-12). The v1 lockfile
    already holds `onnxruntime` (Silero VAD speech gate) and `pyobjc-framework-Vision` (facetrack
    saliency, later Part C OCR), so setup installs both in v1 (D-15);
  - ffmpeg/ffprobe: Homebrew only (D-05), never downloaded or bundled. Setup checks
    `brew --prefix ffmpeg`; if missing, it shows the two commands (install Homebrew, then
    `brew install ffmpeg`) with copy buttons and a "Check again" button;
  - yt-dlp + `yt-dlp-ejs` (official macOS binary; `yt-dlp -U` for updates) and deno;
  - Chrome for HyperFrames via the bundled pinned CLI run with Electron as Node;
  - models downloaded on first use of their stage, size shown first. The Silero VAD model is not
    downloaded: it is vendored in `py/vox_py/models/silero_vad.onnx` and ships with `py/` (D-15).
- Setup screen: every component with size, licence, status, install/repair; ends with engine `doctor`
  → green "Ready" or failures with fixes. Editor opens before setup finishes, with dependent stages
  disabled and labelled.
- `window.vox.setup.status/install/updateYtDlp`.
- electron-builder config (extends the 08 skeleton): `Vox-Studio-<version>-arm64.dmg`, macOS 14+,
  ad-hoc signed, size < 300 MB; notarization hooks present but off. Every resource in R1 "Packaged app"
  as `extraResources` (styles, engine data, agent workflows + prices, HyperFrames CLI/player/runtime/GSAP,
  `py/` + lockfile, uv, `vox` CLI).
- Electron fuses (S27): `RunAsNode` on; `EnableNodeOptionsEnvironmentVariable` and
  `EnableNodeCliInspectArguments` off; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` on.
- `vox self-test --json` in the CLI: `styles.list()` has `base`, `geo.search('lisbon')` returns a place,
  a fixture compiles with the vendored runtime, and the vendored `silero_vad.onnx` is present with the
  SHA-256 in R5 (D-15). Checks for modules built later run only when the
  module is in the build and otherwise report `skipped: <reason>` (D-12): `vox` style present and a
  `vox/map-route` scene compiles without `node_modules` (07), `agent/prices.json` loads (11), workflow
  prompts load (12). Phase 13 makes every check required and adds `vox-apple-llm --status`.
- Update check (in the engine host): GitHub Releases API of the repo (from TODO) on launch → "New
  version" banner; off when no repo is configured.
- Menu "Install `vox` command": links `/usr/local/bin/vox` (admin prompt) or `~/.local/bin/vox` to a
  script running the bundled CLI with `ELECTRON_RUN_AS_NODE=1`.
- README sections: install from `.dmg` (Gatekeeper "Open Anyway" with screenshots, `xattr` alternative),
  Homebrew + ffmpeg (installing Homebrew needs an admin password), clone path (`pnpm install`, `pnpm dev`,
  `pnpm dist`).

## Steps

1. [ ] Setup tests: hash mismatch refused (S16); lock-hash resync: a changed bundled `uv.lock` (fixture)
       triggers one `uv sync --frozen --no-editable` (fake uv records the call), an unchanged one does not,
       and `vox doctor` reports the mismatch with its fix (D-12); a missing tool disables only its stages; repair re-runs one
       component; progress events; ffmpeg missing → copy-command view, "Check again" detects a later
       `brew install ffmpeg` (fake `brew` on `PATH`); no code path downloads ffmpeg.
2. [ ] Installer for each component against local file fixtures (no network in tests); live run tagged `slow`.
3. [ ] Setup screen UI + `doctor` result view.
4. [ ] electron-builder config with all resources and fuses; `pnpm dist` produces the `.dmg`; measure size.
5. [ ] Packaging tests on the built app: `vox self-test --json` from the app's CLI passes (fails if any R1
        resource of a built module is missing; a module not built yet is `skipped`, never `passed`); fuses read back with `@electron/fuses` match S27; S31: hash every file in
        the `.app`, run setup (fixture components, `VOX_TOOLS_DIR` and `VOX_HOME` set to temp folders) and a
        compile, hash again → unchanged.
6. [ ] Update-check unit test with a recorded Releases API response.
7. [ ] "Install `vox` command": automated test of the `~/.local/bin` target under a temp `HOME` (`vox
       --version` works through the link). The `/usr/local/bin` target (admin prompt) is a MANUAL STEP
       (owner, optional — does not block merge).
8. [ ] README install + clone sections.
9. [ ] Clean-install test (automated, `slow`, D-16; replaces a second-account run): give the built `.dmg`
       a quarantine attribute (`xattr -w com.apple.quarantine`), mount it, copy the app to a temp folder,
       record `spctl --assess --type execute` (expected: rejected, which is why the README shows "Open
       Anyway"; log the output), then launch it with temp `VOX_HOME` and `VOX_TOOLS_DIR` and a `PATH`
       without Homebrew. Playwright for Electron checks that the setup screen shows the ffmpeg-missing
       view with its copy commands; then, with fixture components and a fake `brew` on `PATH`, setup reaches
       "Ready". Evidence: `spctl` output and screenshots in `docs/evidence/phase-09/`.
9b. [ ] MANUAL STEP (owner, optional — does not block merge): open the built app once through "Open
       Anyway" on your own account and take screenshots of the Gatekeeper dialog for the README.

## Verify

```bash
pnpm -C apps/desktop test -- setup
pnpm dist && ls -lh apps/desktop/dist/*.dmg
pnpm -C apps/desktop test:slow -- packaging    # self-test, fuses, bundle unchanged (S27, S31)
pnpm -C apps/desktop test:slow -- clean-install   # quarantined .dmg, spctl recorded, setup with temp VOX_HOME, no Homebrew (D-16)
```

## Done when

- [ ] `.dmg` < 300 MB; the clean-install test passes (quarantine, `spctl` recorded, ffmpeg-missing view,
      setup reaches "Ready" with fixture components; D-16). The render
      part of the app spec's packaging smoke test is checked at GATE 5 (10b step 12, D-12).
- [ ] S16, S27 and S31 tests pass; `vox self-test --json` passes on the built app; security review clean of
      CRITICAL/HIGH.
- [ ] README covers `.dmg` install (both Gatekeeper routes), Homebrew + ffmpeg, and the clone path.

## Risks and fallback

| Risk | Fallback |
|---|---|
| User has no Homebrew and no admin password | Setup says ffmpeg stages stay disabled; README names the admin step; editor still opens |
| `uv sync` of mlx/mediapipe fails on a clean install (temp `VOX_TOOLS_DIR`) | Log the exact error; pin wheels in the lockfile; repair button reruns |
| Ad-hoc signature + bundled uv binary triggers extra Gatekeeper prompts | Sign nested binaries ad-hoc in `afterSign`; document if any prompt remains |

## Handoff notes

- Phase 10b's GATE 5 reruns the clean-install test with the full editor, and the owner runs the E2E path
  by hand on their own account with a fresh `VOX_HOME` (D-16).
