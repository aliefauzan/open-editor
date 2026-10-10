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
- `py/` uv project (`pyproject.toml`, `uv.lock`, `vox_py/__init__.py`, one pytest), and the folder
  `py/vox_py/models/` (README naming its future contents: the vendored `silero_vad.onnx` and its MIT
  licence, added with the SHA-256 in phase 04; D-15).
- `packages/engine/test/fixtures/assets/`: two CC0 portraits `faces/face-a.jpg`, `faces/face-b.jpg`, one
  real tap recording `sfx/tap.wav` + `LICENSES.md` (R7 "Checked-in assets"; D-16).
- Checked-in seed media (D-16): `assets/media/talking-head-20s.mp4`, `.mov` and `.webm` (≤ 5 MB each),
  made once by `make.sh --seed-media` on the M5, and `assets/media/SEEDS.json` with each file's SHA-256.
- `packages/engine/test/fixtures/make.sh` producing `spike-source-1080p.mp4`,
  `face-2people.mp4` and `transcripts/spike-90s.json` (R7), plus the D-15 fixtures: `phone-vfr-20s.mp4`,
  `ntsc-2997-20s.mp4`, `cuts-2shot.mp4` + `cuts-2shot.cuts.json`, `podcast-2face.mp4`,
  `speech-fillers.wav`, `music-silence.wav`.
- `packages/engine/test/fixtures/transcripts/speech-fillers.json`: hand-written transcript matching
  `speech-fillers.wav` (words, pauses, fillers, a repeat, `speechRegions`), checked in (R7; D-15).
- `.github/workflows/ci.yml`: `macos-14` (arm64), pnpm install with cache, typecheck, lint, fast tests,
  `uv run pytest` on every push; a `slow` job (`pnpm test:slow`) on `workflow_dispatch` and a weekly
  `schedule`. Tests tagged `local` never run on CI (R3 test tiers, D-16).
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
       Create `py/vox_py/models/` and make the build include `models/*.onnx` and the licence file as
       package data (a test checks a placeholder file ships in the built wheel; D-15).

### C. Fixtures and CI

10. [ ] Fetch two portraits from Wikimedia Commons once (check "CC0" on each file page, ≤ 200 kB each)
        and one real tap or knock recording (CC0 or public domain, no account needed; trim to one hit with
        5 ms fades, mono 48 kHz, save as `sfx/tap.wav`). Commit them with `LICENSES.md` (file URL, author,
        licence). This is the one network step for checked-in fixtures (portraits + tap; R3 exception, D-16).
11. [ ] `make.sh`: `testsrc2` 1080p + burnt-in frame counter (`drawtext` with `%{frame_num}`) + flash
        frames every 2 s + matching click track; talking-head = `face-a.jpg` with a slow pan over a
        `testsrc2` background + `say` speech track (at least 6 short sentences, for quick clips, D-11); `face-2people` = `face-a.jpg` large and `face-b.jpg`
        small side by side; `transcripts/spike-90s.json` = a fixed word list with timings across the 90 s
        (the spike source has no speech). Uses only ffmpeg, `say` and the checked-in assets.
        Deterministic (fixed seeds, fixed durations).
11a. [ ] Seed media (D-16): `make.sh --seed-media` builds `talking-head-20s.mp4` (the talking-head recipe
        above), its `.mov` remux and its `.webm` (VP9/Opus) re-encode into `assets/media/`, and writes
        `assets/media/SEEDS.json` (file name → SHA-256, size). Run it once on the M5 and commit the three
        files (≤ 5 MB each) and the manifest. `make.sh` without the flag never rebuilds them. A fast test
        hashes the three files and fails if any differs from `SEEDS.json`. Everything keyed by media hash
        (04 transcript, seeded shots and facetracks, `VOX_E2E=1` seeds, the 05 offline project) uses these
        committed files.
11b. [ ] D-15 fixtures in `make.sh` (R7 rows): `phone-vfr-20s.mp4` (1080×1920, own burnt-in frame counter,
        jittered pts with `-fps_mode vfr`, `say` speech); `ntsc-2997-20s.mp4` (30000/1001, frame counter,
        flash frames + click track, `say` speech); `cuts-2shot.mp4` (face-a shot, face-b shot, no-face
        shot with one bright moving box, hard cuts at fixed times written to `cuts-2shot.cuts.json`);
        `podcast-2face.mp4` (equal faces; face-b grows to 1.4× for 0.5 s, later for 1.5 s);
        `speech-fillers.wav` (`say` with "um", "uh", a back-to-back repeat and `[[slnc N]]` silences of
        200 ms and 600 ms); `music-silence.wav` (8 s `aevalsrc` chords and beat, 4 s silence, one
        sentence). Hand-write `transcripts/speech-fillers.json` to match the `say` script's word order.
        A VFR check in the test confirms `phone-vfr-20s.mp4` really has uneven pts deltas.
12. [ ] A test runs `make.sh` (slow) and checks durations, resolution and stream count with ffprobe
        (and `r_frame_rate` 30000/1001 for the NTSC clip). Tests on generated fixtures assert tolerances,
        never exact bytes or exact `say` timings (D-16).
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
- [ ] Seed media and `SEEDS.json` are committed; the seed hash test passes (D-16).
- [ ] R5 rows for phase 00 are filled.

## Risks and fallback

| Risk | Fallback |
|---|---|
| `say` voice differs across macOS versions | Pin the voice name (`-v Samantha`); test checks duration only; hash-keyed media is checked in, not regenerated (D-16) |
| No CC0 / public-domain tap recording on Wikimedia Commons fits | Another short real percussive hit (knock, wood block) with the same licence check; never a synthetic sine (D-14) |
| GitHub Actions `macos-14` image lacks ffmpeg | `brew install ffmpeg` step, cached |

## Handoff notes

- Seed media is generated once here; later phases never regenerate it. If the talking-head recipe must
  change, rerun `make.sh --seed-media`, update `SEEDS.json`, and regenerate every hash-keyed seed in the
  same commit (D-16).
- Phase 01 uses `spike-source-1080p.mp4`, `phone-vfr-20s.mp4`, `ntsc-2997-20s.mp4` and
  `speech-fillers.wav`; phase 02 uses `transcripts/speech-fillers.json`; phase 04 uses
  `talking-head-20s.mp4` and the other D-15 fixtures (R7).
