# R1 — Repository layout and package boundaries

Source: engine spec "Repository layout", app spec "Architecture", agent spec "Context".
This file adds which phase creates each folder and the import rules. The spec wins on conflict.

## Tree

```
videoeditor/
  package.json                 # workspace root; "packageManager": "pnpm@<pin>"; scripts: test, lint, typecheck, dev, dist, eval
  pnpm-workspace.yaml          # packages/*, apps/*
  tsconfig.base.json           # strict, ESM, NodeNext
  .github/workflows/ci.yml     # macos-14 arm64: install, typecheck, lint, test (phase 00)
  packages/
    engine/                    # phase 02–05 · TS library, no CLI entry
      src/model/               # 02 · zod schemas, types, normalise/denormalise, frame grid, deriveCaptions (03)
      src/ops/                 # 02 · edit operations
      src/history/             # 02 · change records, undo cursor, recovery, lockfile, snapshots
      src/paths.ts             # 02 · the path rule + projects-folder resolution; subpath export `@vox/engine/paths` for the app's main process
      src/styles/              # 03 · registry + loader (format in styles spec Part A); 06 adds tooling
      src/compile/             # 03 · sequence → HyperFrames build (in memory + to disk), vendored runtime
      src/audio/               # 03 · ffmpeg mix graph, loudnorm, stems; cues.ts (cue list → build/<seq>/audio/cues.json, D-14)
      src/render/              # 03 · layer renderer (ProRes 4444 MOV) + hybrid compositor
      src/stages/              # 04 · ingest (+ sources.ts: URL classification, D-13; VFR check, CFR copy, loudness, D-15), transcribe, shots.ts (ffmpeg `scdet`, no Python, D-15), facetrack (+ TS crop-path builder, D-15) · 05 · assets, render (+ mux, uses src/render), export, audioQa, quickClips
      src/text/fillers.ts      # 02 · filler word lists per language, used for word kinds (D-15)
      src/export/target.ts     # 05 · export targets {file}|{dir}: temp + rename, no silent replace (D-13, S32)
      src/net/                 # 04 · filtering proxy, private-address check
      src/jobs.ts              # 04 · job runner with progress events
      src/py.ts                # 04 · typed bridge to py/ tools
      src/errors.ts            # 02 · VoxError + codes
      src/log.ts               # 02 · logs/engine.log, rotated at 5 MB, 3 files kept (D-16)
      src/config.ts            # 04 · ~/.vox/config.json, the only reader/writer (agent, cli, app use it)
      src/redact.ts            # 04 · secret redactor (patterns + registered key values; agent registers keys in 11)
      data/                    # 03 · Natural Earth populated places + places index (bundled)
      src/api.ts               # 02 (grows each phase) · the only public entry
      test/                    # unit, compile snapshots, contract tests, integration
      test/fixtures/make.sh    # 00 · offline fixtures (R7); assets/sfx/tap.wav (CC0/PD, checked in, 00)
      test/fixtures/assets/media/ # 00 · checked-in seed media talking-head-20s.{mp4,mov,webm} + SEEDS.json (D-16)
    agent/                     # phase 11–12
      src/providers/           # 11 · provider factory + presets, probe, prices; apple.ts (Apple on-device over the Swift helper)
      src/config/              # 11 · provider entries, Keychain refs, masking (file I/O via engine config)
      src/tools/               # 11 · read/write/job tools generated from engine zod schemas
      src/loop/                # 11 · streamText loop, compaction, run record, events, plan mode
      workflows/               # 12 · clipper.md, stylize.md, edit.md (+ screenplay.md 14, style-extract.md 15)
      evals/                   # 12 · models.json, fixtures, scorecard
    cli/                       # `vox` binary; 02 starts it (op/undo/redo/history), each phase adds commands
  styles/
    base/                      # 03 · engine's built-in style (fonts Inter + IBM Plex Mono in assets/fonts/)
    <styleId>/captions/        # caption presets: <preset>.html + <preset>.json (case, stripPunctuation, safeArea; D-15); base/plain 03, vox 07
    vox/                       # 07 · Part B (v1.1 templates in 14); assets/motion.js, assets/geo/ (TopoJSON),
                               #      assets/sfx/ (CC0 or project recordings + CREDITS.md, D-14),
                               #      templates/map-route/vendor/ (d3-geo, topojson-client as ESM)
  apps/
    desktop/                   # phase 08–10b, 13
      src/main/                # windows, menus, protocols, IPC routing, dialogs, setup screen hosting
      src/engine-host/         # utilityProcess: openEngine + agent; all jobs, file I/O, network, keys;
                               #   setup/ (09: tool downloads), update check (09)
      src/preload/             # contextBridge `window.vox` (typed, generated from one schema)
      src/shared/              # the one zod schema for window.vox
      src/renderer/            # React 19 + Zustand + Tailwind/shadcn
      e2e/                     # Playwright for Electron
  py/                          # 00 · uv project skeleton, Python 3.12; 04 adds the tools
    pyproject.toml, uv.lock
    vox_py/transcribe.py, vad.py (Silero VAD via onnxruntime, 04, D-15), facetrack.py (MediaPipe + Vision body/saliency, 04), doctext.py (pdf, 04), cutout.py (05), timeline.py (05), audioqa.py (+ audioqa_thresholds.json, 05, D-14), ocr.py (15), measure.py (15)
    vox_py/models/             # 00 · folder + package-data rule · 04 · vendored silero_vad.onnx + its MIT licence (SHA-256 in R5, D-15)
  native/
    apple-llm/                 # 11 · Swift Package: `vox-apple-llm` (Apple Foundation Models helper, macOS 26+ SDK)
  scripts/                     # 05 · gate2.sh, make-offline-project.ts · 14b · make-screenplay-set.ts
  spike/                       # phase 01 · not shipped; kept for re-running the spike on upgrades
  docs/
    superpowers/specs/         # the specs
    SPIKE_RESULTS.md           # 01
    evidence/phase-NN/         # screenshots, measurements (R7)
  plan/                        # this plan
  projects/                    # dev scratch only, gitignored; real projects in ~/Movies/Vox Studio (D-10)
  .worktrees/                  # one git worktree per running phase (PROMPT step 3), gitignored
  .claude/skills/vox-studio/   # phase 14 · Claude Code skill
```

## Project folder additions (D-15)

The project folder layout is in engine spec "Project folder". D-15 adds:

| Path | Created by | Phase |
|---|---|---|
| `media/<mediaId>.cfr.mp4` | ingest, for a VFR video (`MediaItem.cfrPath`) | 04 |
| `shots/<mediaId>.json` | `shots` stage (`MediaItem.shotsPath`) | 04 |
| `snapshots/auto-pre-migrate-v<N>.json` | project load, before a migration | 02 |
| `cache/prerender/<hash>.mp4` | app engine host, only if GATE 1 records a heavy-scene fps margin under 20 % | 10a |

## Import rules

| From | May import | Never imports |
|---|---|---|
| `packages/engine` | node built-ins, its own deps | `agent`, `cli`, `apps/*` |
| `packages/agent` | `@vox/engine` (only `src/api.ts` exports) | `cli`, `apps/*` |
| `packages/cli` | `@vox/engine`, `@vox/agent` | `apps/*` |
| `apps/desktop/src/engine-host` | `@vox/engine`, `@vox/agent` | renderer code |
| `apps/desktop/src/main` | `apps/desktop/src/shared`, `@vox/engine/paths` (path rule only) | `@vox/engine` main entry, agent |
| `apps/desktop/src/renderer` | `apps/desktop/src/shared` (types only), UI libs | any Node module, engine, agent |
| `styles/*` templates | `vox-runtime.js` (provided by compile), vendored GSAP, the style's own assets (e.g. `motion.js`) | network, Node |
| `styles/*` compile hooks (`build.mjs`) | relative imports of vendored ESM inside the style folder; `ctx` (`seed`, `readAsset`) | bare package imports, network, files outside the style |

Enforced by an ESLint `no-restricted-imports` rule per package (phase 00) and checked in CI.

## Packaged app (phase 09)

electron-builder copies these into `Vox Studio.app/Contents/Resources/` as real files
(`extraResources`, not inside the asar), per app spec "Packaging and sharing":

| Resource path | From | Used by |
|---|---|---|
| `styles/base`, `styles/vox` (fonts, textures, SFX, previews) | `styles/` | engine host passes `<resources>/styles` as `stylesDirs[0]`, then `~/.vox/styles` |
| `engine-data/` | `packages/engine/data/` | `geo.search`, `map-route` |
| `agent/workflows/*.md`, `agent/prices.json` | `packages/agent/` | agent loop |
| `hyperframes/` (CLI, player, runtime, GSAP) | pinned node packages | compile (vendors runtime + GSAP), render, player |
| `py/` + `uv.lock` (incl. vendored `vox_py/models/silero_vad.onnx`, D-15), `bin/uv` | `py/`, pinned uv | first-run `uv sync --frozen` into `<tools>/py-env` |
| `cli/` | `packages/cli` build | "Install `vox` command", `vox self-test` |
| `bin/vox-apple-llm` | `native/apple-llm` release build (phase 13) | Apple on-device provider; `vox self-test` runs `--status` |

The packaging test (09) runs `vox self-test --json` from the built app and fails if any row is missing.

## Package names

`@vox/engine`, `@vox/agent`, `@vox/cli` (bin `vox`), `@vox/desktop` (private).
