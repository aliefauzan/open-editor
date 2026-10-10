# Phase 00 — Foundation

| Field | Value |
|---|---|
| Status | done |
| Started · Finished | 2026-10-10 23:40 · 2026-10-11 00:25 |
| Model | Sonnet 5.5 · medium |
| Machine | M5, macOS 27.0.1, Node 24.14.0, pnpm 12.0.0, ffmpeg 8.1.2, uv 0.11.19, Python 3.12.13 |
| Branch | main (phase 00 works on main, no worktree) |
| Resume from | |

## Pre-check
TODO "Before phase 00" ticked. Repo existed (3 commits, origin in sync); step A1 already satisfied. LICENSE
holder was a personal name; changed to "Vox Studio contributors" (2026). Homebrew ffmpeg has no `drawtext`
(see D-17). `say` voice Samantha present.

## Plan summary
Root tooling first, then empty packages, py project, CC0 assets, `make.sh` + seed media, CI. Test order:
version tests, cli `--version`, ESLint rule tests (R1, S26), pytest + wheel package-data test, seed hash
test + asset tests (fast), `make.sh` ffprobe/barcode tests (slow). The `make.sh` script and its slow test were
written together and checked by hand against ffprobe (generator code is config-like); the VFR pts bug was
caught that way (x264 snapped pts to 1/30 s until `-enc_time_base 1/90000`).

## Checklist
- [x] A1 repo, .gitignore, LICENSE (MIT, Vox Studio contributors), README stub (history kept)
- [x] A2 root package.json (`packageManager` pnpm@12.0.0), pnpm-workspace.yaml
- [x] A3 tsconfig.base.json (strict, ESM, NodeNext), per-package tsconfig
- [x] A4 ESLint flat config: typescript-eslint, Prettier, R1 `no-restricted-imports`, S26 rules (tested)
- [x] A5 vitest config: `pnpm test` (fast), `pnpm test:slow`; `*.local.test.ts` skipped when `CI` is set
- [x] A6 pins recorded in R5
- [x] B7 engine `src/api.ts` + test; B8 agent, cli (`pnpm -C packages/cli exec vox --version` prints `vox 0.0.0`), apps/desktop placeholder
- [x] B9 py uv project, hatchling, pytest, `models/` package data (wheel test)
- [x] C10 two CC0 portraits + one CC0 knock recording from Wikimedia Commons, `assets/LICENSES.md`
- [x] C11, 11a, 11b `make.sh` and `make.sh --seed-media`; seed media + `SEEDS.json` committed; `speech-fillers.json`
- [x] C12 slow test runs `make.sh` and checks every fixture
- [x] C13 `.github/workflows/ci.yml`; commands run locally from a fresh clone first, then on GitHub

## Files created / changed
Root: `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`,
`.prettier*`, `.nvmrc`, `.gitignore`, `README.md`, `LICENSE`, `.github/workflows/ci.yml`, `test/lint-rules.test.ts`.
`packages/{engine,agent,cli}` (src, test, cli `bin/vox.js`), `apps/desktop/package.json`, `py/` (pyproject, uv.lock,
`vox_py`, `models/`, tests), `packages/engine/test/fixtures/` (`make.sh`, `assets/`, `transcripts/`,
`../fixtures.test.ts`, `../fixtures.slow.test.ts`), `docs/evidence/.gitkeep`, `spike/README.md`.
Bookkeeping: `plan/ref/R5-pins.md`, `plan/PROGRESS.md`, `plan/log/DECISIONS.md` (D-17).

## Verify results
| Command | Result | Numbers |
|---|---|---|
| `pnpm install --frozen-lockfile` (fresh clone) | pass | |
| `pnpm typecheck && pnpm lint && pnpm test` | pass | vitest 37 tests, 5 files; ESLint no issues; Prettier clean |
| `uv run --project py pytest` | pass | 4 passed (includes `uv build --wheel` shipping `models/placeholder.onnx`) |
| `uv run --frozen --project py python -I -m vox_py` | pass | prints `vox_py 0.0.0` |
| `bash .../make.sh` + ffprobe of `spike-source-1080p.mp4` | pass | 90.000000 s; `make.sh` ~21 s wall on M5 |
| `pnpm test:slow` (local) | pass | 11 tests, 22 s |
| CI push run on `041b490` (macos-14) | green | fast job: typecheck, lint, test, pytest |
| CI `workflow_dispatch` run | green | slow job (fixture generation with `say` on the runner) and fast job |

Fixture sizes: seed media mp4 3.6 MB, mov 3.6 MB, webm 2.8 MB (each under 5 MB).

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | Verify passes from a fresh clone | fresh `git clone` into the scratchpad, all Verify commands green |
| 2 | CI is green | GitHub Actions runs 38066521071 (push) and 38066641604 (dispatch), both success |
| 3 | Fixtures generate offline in under 2 minutes | slow test asserts it; ~21 s measured |
| 4 | Seed media + SEEDS.json committed; hash test passes | `packages/engine/test/fixtures.test.ts` |
| 5 | R5 rows for phase 00 filled | `plan/ref/R5-pins.md` |

## Review findings
Agents run: ecc code-reviewer and ecc typescript-reviewer (R6 phase 00).
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| typescript-reviewer | HIGH | S26 bypasses (require, dynamic import, aliased/namespace exec, `shell: '/bin/sh'`) | yes, selectors + tests |
| typescript-reviewer | HIGH | R1 gaps: relative paths, `.mts` etc., main allows `@vox/engine/*`, `node:`-only builtins | yes, tests added |
| typescript-reviewer | MEDIUM | loose lint test regex; `bin` in tsconfig include but not checked; `no-restricted-syntax` replaced by later blocks | partly: tests now assert S26 messages and many bypasses; rest noted below |
| code-reviewer | MEDIUM | `drawbox` `t` is thickness, so the box in `cuts-2shot` did not move | yes, overlay with `eval=frame`, slow test checks motion |
| code-reviewer | MEDIUM | runner may lack voice Samantha | yes, preflight in `make.sh`; the dispatch run passed on macos-14 |
| code-reviewer | LOW | slow include missed `test/**`; flash comment; CRF override unclear | yes |
| code-reviewer | LOW | `uv build` in pytest needs network for hatchling | no (works on CI and with network; note) |
| typescript-reviewer | LOW | engine/agent `version` hard-coded twice; `isolatedModules` etc. | no (backlog) |

## Deviations
- No `drawtext`: frame counter is a binary barcode (D-17).
- LICENSE holder changed from a personal name to "Vox Studio contributors".
- `speech-fillers.json` timings are estimates (no word timestamps from `say`).
- `transcripts/spike-90s.json` is generated by `make.sh` and also committed (raw awk output; excluded from Prettier).
- `pnpm -C packages/cli exec vox` works because the root `package.json` has `@vox/cli` as a workspace devDependency
  (pnpm does not link a package's own bin into its own `.bin`).

## MANUAL STEPS
None.

## Handoff notes
- Fixtures: `bash packages/engine/test/fixtures/make.sh` (about 20 s). Counter = 16-bit barcode, see D-17.
  `decodeCounter()` in `fixtures.slow.test.ts` is a reference decoder (ffmpeg crop 640x40 at 40,40, scale to 16x1 gray).
- `phone-vfr-20s.mp4`: `r_frame_rate` 90000/1, `avg_frame_rate` about 30/1; pts jitter 15 ms amplitude.
- Pins: TypeScript 6.0.3 (typescript-eslint caps at <6.1), vitest 5.0.3, ESLint 10.12.0, pnpm 12.0.0, Node 24.14.0.
- Packages run TypeScript directly: `exports` points at `src/api.ts` and `bin/vox.js` relies on Node 24 type
  stripping, which only works while the package resolves outside `node_modules` (workspace symlink). Phase 09
  (packaging) needs a build step or `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` will appear.
- Imports of `.ts` files need the `.ts` extension (`allowImportingTsExtensions`, `erasableSyntaxOnly`: no enums or
  parameter properties).
- Test tiers: `*.slow.test.ts` run only with `VOX_SLOW=1` (`pnpm test:slow`); `*.local.test.ts` run locally, skipped when `CI` is set.
- S26 lint: only named imports of `spawn`/`execFile` from `child_process`; `spawn('sh', ['-c', ...])` is not caught by lint, review for it.
- `vitest` under the RTK hook may print a passthrough note and write `.vitest/`; it is gitignored.
- Seed media is never regenerated by plain `make.sh`. If the recipe changes, rerun `--seed-media` and update `SEEDS.json`.
- Python: `uv sync --reinstall-package vox_py` if `python -I -m vox_py` cannot import after adding new files to a stale env.
- GitHub: `fast` job also runs on `workflow_dispatch`; weekly schedule runs only `slow`.
