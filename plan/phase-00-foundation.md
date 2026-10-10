# Phase 00 — Foundation

| Field | Value |
|---|---|
| Track | all |
| Prereq | specs approved (TODO "Before phase 00"; done, D-10) |
| Spec § | engine "Repository layout"; overview "Technology and licences" |
| Model | Sonnet 5.5 · medium |
| Gate | — |
| Next | 01 and 02 (can run in parallel) |

## Goal

An empty but working monorepo: every later phase can add code, run `pnpm test`, and get a green CI on
Apple Silicon. Fixtures can be generated offline.

## Required reading

- Overview spec (all), engine spec "Repository layout" and "Testing" (offline fixture).
- `plan/ref/R1-repo-layout.md`, `R3-conventions.md`, `R5-pins.md`, `R7-fixtures-evidence.md`.

## Output

- `git init`, `.gitignore` (R3 §git, incl. `.worktrees/`), `LICENSE` (MIT, D-10), `README.md` stub (what it
  is, status "in development", link to specs and plan).
- `package.json` (workspace root, `packageManager`, scripts `test`, `test:slow`, `lint`, `typecheck`),
  `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`, ESLint + Prettier config.
- Empty packages with one passing test each: `packages/engine`, `packages/agent`, `packages/cli`
  (bin `vox` prints `vox <version>`), `apps/desktop` (placeholder `package.json` only; scaffold is phase 08).
- `py/` uv project (`pyproject.toml`, `uv.lock`, `vox_py/__init__.py`, one pytest).
- `packages/engine/test/fixtures/assets/`: two CC0 portraits `faces/face-a.jpg`, `faces/face-b.jpg` +
  `LICENSES.md` (R7 "Checked-in assets").
- `packages/engine/test/fixtures/make.sh` producing `talking-head-20s.mp4`, `spike-source-1080p.mp4`,
  `face-2people.mp4` and `transcripts/spike-90s.json` (R7).
- `.github/workflows/ci.yml`: `macos-14` (arm64), pnpm install with cache, typecheck, lint, fast tests,
  `uv run pytest`.
- `docs/evidence/`, `projects/` (dev scratch, gitignored; real projects live in `~/Movies/Vox Studio/`,
  D-10), `spike/` (empty, README only).

## Steps

### A. Repo and tooling

1. [ ] `git init -b main`; write `.gitignore` (R3 §git), `LICENSE` (MIT text, current year, "Vox Studio
       contributors"), README stub. Commit `plan/` and `docs/` as they are first (`plan-00: import plan
       and specs`).
2. [ ] Root `package.json` with pinned `packageManager`; `pnpm-workspace.yaml` (`packages/*`, `apps/*`).
3. [ ] `tsconfig.base.json` (strict, ESM, NodeNext); per-package `tsconfig.json` extends it.
4. [ ] ESLint flat config: typescript-eslint, Prettier, `no-restricted-imports` per R1 boundary table,
       and a rule (or CI grep) that forbids `child_process.exec`/`execSync` and `shell: true` (S26).
5. [ ] vitest workspace config; `pnpm test` runs all packages; `test:slow` runs tests tagged `slow`.
6. [ ] Record exact pins for Node, pnpm, TypeScript, vitest, ESLint in R5.

### B. Packages

7. [ ] `packages/engine`: `src/api.ts` exporting `version`; test asserts it.
8. [ ] `packages/agent`, `packages/cli` the same; `vox --version` works via `pnpm -C packages/cli exec vox --version`.
9. [ ] `py/`: `uv init --package` (Python 3.12, build backend hatchling packaging `vox_py`), pytest;
       `uv run --project py pytest` and `uv run --frozen --project py python -I -m vox_py` both pass.

### C. Fixtures and CI

10. [ ] Fetch two portraits from Wikimedia Commons once (check "CC0" on each file page, ≤ 200 kB each),
        commit them with `LICENSES.md` (file URL, author, licence). This is the only network step for
        fixtures (R3 exception).
11. [ ] `make.sh`: `testsrc2` 1080p + burnt-in frame counter (`drawtext` with `%{frame_num}`) + flash
        frames every 2 s + matching click track; talking-head = `face-a.jpg` with a slow pan over a
        `testsrc2` background + `say` speech track (at least 6 short sentences, for quick clips, D-11); `face-2people` = `face-a.jpg` large and `face-b.jpg`
        small side by side; `transcripts/spike-90s.json` = a fixed word list with timings across the 90 s
        (the spike source has no speech). Uses only ffmpeg, `say` and the checked-in assets.
        Deterministic (fixed seeds, fixed durations).
12. [ ] A test runs `make.sh` (slow) and checks durations, resolution and stream count with ffprobe.
13. [ ] CI workflow; run it locally with the same commands first.

## Verify

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test
uv run --project py pytest
bash packages/engine/test/fixtures/make.sh && ffprobe -v error -show_entries format=duration -of csv=p=0 packages/engine/test/fixtures/out/spike-source-1080p.mp4
```

## Done when

- [ ] All commands in Verify pass from a fresh clone.
- [ ] CI is green (or, without a remote yet, the CI commands pass locally and the log says so).
- [ ] Fixtures generate offline in under 2 minutes.
- [ ] R5 rows for phase 00 are filled.

## Risks and fallback

| Risk | Fallback |
|---|---|
| `say` voice differs across macOS versions | Pin the voice name (`-v Samantha`); test checks duration only |
| GitHub Actions `macos-14` image lacks ffmpeg | `brew install ffmpeg` step, cached |

## Handoff notes

- Phase 01 uses `spike-source-1080p.mp4`; phase 04 uses `talking-head-20s.mp4`.
