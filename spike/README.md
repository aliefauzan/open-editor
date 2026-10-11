# spike/

Phase 01 HyperFrames + Electron spike (GATE 1). Not shipped. Kept so the spike can be re-run when a
pinned version (HyperFrames, @hyperframes/player, GSAP, Electron) changes. Results:
`docs/SPIKE_RESULTS.md`.

## Rerun everything

```bash
packages/engine/test/fixtures/make.sh   # fixtures, once (or set VOX_FIXTURES)
pnpm install
pnpm -C spike bench:all                 # about 6 min on the M5
```

`bench:all` builds the projects (`make-project.ts`), runs every measurement under the shared bench
lock (`.git/vox-bench.lock`), writes evidence JSON to `spike/out/evidence/`, and prints one JSON line
per pass-bar item 1–9, the heavy-scene fps margin, and the GATE 1 outcome (`lib/gate.ts`).

Options: `--reuse` (keep existing renders; items 3 and 5 are then not re-measured), `--skip-fillers`,
`--evidence-dir DIR`. Load averages are recorded with every timing; measure on an idle machine.

## Pieces

| Path                  | What                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `make-project.ts`     | hand-written builds: `out/project` (render), `out/preview` (preview), `out/project-ntsc`       |
| `lib/compile.ts`      | sequence model to HyperFrames HTML (instance files, `vox.vars`, tokens)                        |
| `templates/`          | scene templates, `vox-runtime.js`, `vox-preview.js` (patch path and preview helpers)           |
| `bench/render.ts`     | items 1, 2, 3, 5 (`--seq main`) and 9 (`--seq ntsc`)                                           |
| `bench/mechanisms.ts` | item 7, render side                                                                            |
| `bench/fillers.ts`    | item 8 (mlx-whisper through `uv run --with`)                                                   |
| `bench/preview.ts`    | items 4, 6, 7 (preview side) and the fps margin, in `electron/` (`--mode opaque\|same-origin`) |
| `electron/`           | the app's window security (schemes, CSPs, opaque sandbox) and the preview tests                |

Single runs: `node bench/preview.ts --mode opaque`, `node bench/render.ts --seq main`. Debug: the
Electron window alone is `electron electron/main.ts --out out/r.json --tests play,seek`;
`VOX_PROBE_DUMP=<file>` writes the raw play recording.

HyperFrames CLI calls run with `HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1`.
