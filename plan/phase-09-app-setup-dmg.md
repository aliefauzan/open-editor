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

A friend with an Apple Silicon Mac can install the `.dmg`, get past Gatekeeper once, and reach a green
"Ready" setup screen. The only terminal step is installing Homebrew + ffmpeg (D-05), shown with copy
buttons. Builders can clone and `pnpm dist` themselves.

## Required reading

- App spec sections above; R4 rows S16, S27, S31; R5 "External tools"; R1 "Packaged app (phase 09)".
- D-05 (ffmpeg from Homebrew only).
- D-02 (ad-hoc signing, update check).

## Output

- `src/engine-host/setup/` (downloads run in the engine host, which owns the network; main only hosts
  the screen): `manifest.json` (component, version, URL, SHA-256, size, licence), installer with
  progress events (`setup.progress`), repair per component, into
  `~/Library/Application Support/Vox Studio/tools/`:
  - bundled uv → `uv sync --frozen --no-editable` of the bundled `py/` (lockfile) into `<tools>/py-env`
    (`UV_PROJECT_ENVIRONMENT`), cache `<tools>/uv-cache` (`UV_CACHE_DIR`), Python in `<tools>/python`
    (`UV_PYTHON_INSTALL_DIR`); the engine then runs `uv run --frozen --no-sync`; nothing is written into
    the app bundle;
  - ffmpeg/ffprobe: Homebrew only (D-05), never downloaded or bundled. Setup checks
    `brew --prefix ffmpeg`; if missing, it shows the two commands (install Homebrew, then
    `brew install ffmpeg`) with copy buttons and a "Check again" button;
  - yt-dlp + `yt-dlp-ejs` (official macOS binary; `yt-dlp -U` for updates) and deno;
  - Chrome for HyperFrames via the bundled pinned CLI run with Electron as Node;
  - models downloaded on first use of their stage, size shown first.
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
- `vox self-test --json` in the CLI: `styles.list()` has `base` and `vox`, `geo.search('lisbon')` returns
  a place, workflow prompts load, a fixture compiles with the vendored runtime, and a `vox/map-route`
  scene compiles (its vendored hook libraries load without `node_modules`). Phase 13 adds the
  `vox-apple-llm --status` check.
- Update check (in the engine host): GitHub Releases API of the repo (from TODO) on launch → "New
  version" banner; off when no repo is configured.
- Menu "Install `vox` command": links `/usr/local/bin/vox` (admin prompt) or `~/.local/bin/vox` to a
  script running the bundled CLI with `ELECTRON_RUN_AS_NODE=1`.
- README sections: install from `.dmg` (Gatekeeper "Open Anyway" with screenshots, `xattr` alternative),
  Homebrew + ffmpeg (installing Homebrew needs an admin password), clone path (`pnpm install`, `pnpm dev`,
  `pnpm dist`).

## Steps

1. [ ] Setup tests: hash mismatch refused (S16); a missing tool disables only its stages; repair re-runs one
       component; progress events; ffmpeg missing → copy-command view, "Check again" detects a later
       `brew install ffmpeg` (fake `brew` on `PATH`); no code path downloads ffmpeg.
2. [ ] Installer for each component against local file fixtures (no network in tests); live run tagged `slow`.
3. [ ] Setup screen UI + `doctor` result view.
4. [ ] electron-builder config with all resources and fuses; `pnpm dist` produces the `.dmg`; measure size.
5. [ ] Packaging tests on the built app: `vox self-test --json` from the app's CLI passes (fails if any R1
        resource is missing); fuses read back with `@electron/fuses` match S27; S31: hash every file in
        the `.app`, run setup (fixture components, `VOX_TOOLS_DIR` and `VOX_HOME` set to temp folders) and a
        compile, hash again → unchanged.
6. [ ] Update-check unit test with a recorded Releases API response.
7. [ ] "Install `vox` command": automated test of the `~/.local/bin` target under a temp `HOME` (`vox
       --version` works through the link). The `/usr/local/bin` target (admin prompt) is a MANUAL STEP
       (owner, optional — does not block merge).
8. [ ] README install + clone sections.
9. [ ] MANUAL STEP (owner): on the second macOS user account, install the `.dmg`, do the Gatekeeper step,
       run setup to "Ready"; take screenshots of the Gatekeeper dialog and the Ready screen into
       `docs/evidence/phase-09/`.

## Verify

```bash
pnpm -C apps/desktop test -- setup
pnpm dist && ls -lh apps/desktop/dist/*.dmg
pnpm -C apps/desktop test:slow -- packaging    # self-test, fuses, bundle unchanged (S27, S31)
```

## Done when

- [ ] `.dmg` < 300 MB, installs on the second account, setup reaches "Ready" (owner evidence).
- [ ] S16, S27 and S31 tests pass; `vox self-test --json` passes on the built app; security review clean of
      CRITICAL/HIGH.
- [ ] README covers `.dmg` install (both Gatekeeper routes), Homebrew + ffmpeg, and the clone path.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Friend has no Homebrew and no admin password | Setup says ffmpeg stages stay disabled; README names the admin step; editor still opens |
| `uv sync` of mlx/mediapipe fails on the clean account | Log the exact error; pin wheels in the lockfile; repair button reruns |
| Ad-hoc signature + bundled uv binary triggers extra Gatekeeper prompts | Sign nested binaries ad-hoc in `afterSign`; document if any prompt remains |

## Handoff notes

- Phase 10b's GATE 5 reruns this smoke test with the full editor.
