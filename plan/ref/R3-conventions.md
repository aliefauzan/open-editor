# R3 — Conventions

## Language and tooling

- TypeScript strict, ESM, `moduleResolution: NodeNext`. Node 24 for dev and CLI; the app runs the CLI
  with Electron as Node (`ELECTRON_RUN_AS_NODE=1`), so code must also run on Electron's Node version.
- pnpm workspaces; `packageManager` pinned. No global installs in scripts.
- zod for every boundary: op args, tool args, IPC args, Python bridge, config, style/template files.
- Lint: ESLint (typescript-eslint) + Prettier. Import boundaries per R1.
- Python: uv project in `py/`, Python 3.12, run as `uv run --frozen --project py python -I -m vox_py.<tool>`
  (in the packaged app `uv run --frozen --no-sync`, with `UV_PROJECT_ENVIRONMENT`, `UV_CACHE_DIR` and
  `UV_PYTHON_INSTALL_DIR` in the tools folder, so a run never syncs or writes into the bundle).
  Never bare `python3` (on this Mac it can exit 69 on the Xcode licence check). Python formatting: ruff.
- Vendored model files (D-15; e.g. `py/vox_py/models/silero_vad.onnx`) are committed with their licence
  and a SHA-256 in R5. The loader checks the hash and fails on a mismatch; they are never downloaded at
  run time. The Silero VAD model runs through `onnxruntime`, not torch.

## Tests

- vitest for TS (`pnpm test`), pytest for `py/` (`uv run --project py pytest`).
- Write the failing test first. A bug fix starts with a test that reproduces it.
- Test names say the behaviour: `trimItem keeps linked A1 in sync at 24 fps`.
- Test tiers (D-16):
  - **fast** (`pnpm test`): typecheck, lint, vitest, fast pytest, agent replay fixtures, mock injection
    eval. CI runs it on every push.
  - **slow** (`pnpm test:slow`): render, Electron E2E with the seeded fixtures (`VOX_E2E=1`), packaging
    and clean-install tests, latency bench (warning only). CI runs it on `workflow_dispatch` and once a
    week.
  - **local**: mlx-whisper, real MediaPipe, the real Apple helper, the real Keychain, live providers and
    unseeded E2E. Never on CI. Local Verify on the M5 is the merge gate (PROMPT step 8).
- Never mock the thing under test. Mock providers with `MockLanguageModelV4` from `ai/test`.
- Tests never touch the owner's data: every test, E2E run and Verify block sets `VOX_PROJECTS_DIR`,
  `VOX_HOME` and `VOX_TOOLS_DIR` to `mktemp -d` folders (engine spec "Project folder"). Keychain tests use
  service `Vox Studio Test` and delete their items.
- Fixtures are generated, not downloaded (R7). The only exceptions are the checked-in files listed in
  R7: two CC0 portraits and one CC0 / public-domain `tap.wav` (fetched once in phase 00 step 10, the
  one network step for checked-in fixtures, with their licences), the seed media
  `talking-head-20s.{mp4,mov,webm}` generated once and committed with `SEEDS.json` (D-16), recorded
  yt-dlp outputs, transcripts generated once by phase 04, and the hand-written
  `transcripts/speech-fillers.json` for the `removePauses`/`removeWords` tests (D-15).
- Audio QA thresholds (`py/vox_py/audioqa_thresholds.json`) are never loosened to make a check pass.
  A failing sound is replaced or its cue is muted or moved (D-14). A threshold change needs a DECISIONS
  entry with the owner's approval.

## Errors

- Throw `VoxError { code, message, hint, cause? }` from `engine/src/errors.ts`. `hint` tells the user
  what to do next. `cause` for external tools holds the last 40 stderr lines, redacted.
- No silent fallbacks: if a stage cannot do its job it fails with a code, or reports a skipped step.

## External processes

- Spawn with an argument array, never through a shell. No string-built command lines.
- ffmpeg/ffprobe on untrusted input always get `-format_whitelist` and `-protocol_whitelist file,pipe`.
- yt-dlp always goes through the filtering proxy with the flags in the engine spec "Ingest hardening"
  (`--no-playlist --playlist-items 1`, `-f "bv*+ba/b" -S "res:1080"`; D-13). `--cookies-from-browser`
  only from the user's `ingest.cookiesFromBrowser` setting (S33).
- Every child process gets an `AbortSignal`; cancel kills it.

## Times and ids

- Times are integer milliseconds. Never floats in the model. Timeline times (`startMs`, `durationMs`, …)
  snap to the sequence's frame grid; a clip's `inMs` snaps to its source's grid (`MediaItem.fps`) (D-15).
- Frame rates are rational `{ num, den }` from the fixed set (24/1, 25/1, 30/1, 60/1, 24000/1001,
  30000/1001, 60000/1001). Convert only through the engine's frame helpers:
  `ms(f) = Math.round(f * 1000 * den / num)`, `frame(ms) = Math.round(ms * num / (1000 * den))` (D-15).
- Agent tool fields name their time frame: `srcMs` = source time, `seqMs` = sequence time (D-15).
- Ids are short, stable, prefixed (`m_`, `seq_`, `it_`, `run_`); never reused.
- Track ids are the exception: `V1..Vn` and `A1..An`, unique within a sequence, as the engine spec
  fixes them (the clipper and `placeClip` default to `A1`).

## Files and paths

- Every project-relative path goes through `engine/src/paths.ts`. No ad-hoc `path.join` on user input.
- Writes that matter use temp file + `fsync` + rename (see engine "Write order").
- Exports go only to an export target (engine "Export targets"): a temp file in the target folder, then
  rename; an existing file is never replaced silently (`EXPORT_PATH` unless `--overwrite`; S32).
- File names must not contain `token`, `secret`, `password`, `credentials` or `apikey`.

## Git

- The root checkout stays on `main`. Each phase's code lives in a worktree `.worktrees/phase-<NN>` on
  branch `phase/<NN>-<slug>` (D-10). Commit at each green checkpoint.
- Bookkeeping (`plan/**`, `docs/**`, evidence) is edited only in the root checkout and committed on
  `main` at once (`plan-<NN>: <what>`). Phase branches never touch `plan/**` or `docs/**`, so they never
  conflict there.
- Commit message: `phase-NN: <imperative summary>`; body lists the steps done. End with the attribution
  line the session requires.
- Merging a finished phase (PROMPT step 11): merge `main` into the phase branch inside the worktree,
  resolve conflicts (lockfiles take `main`'s version and are regenerated with `pnpm install` / `uv lock`;
  manifests and config files keep both sides' entries; code keeps both intents; unsure → `git merge
  --abort`, log, stop), re-run Verify, then `git merge --no-ff` into `main` (D-07). Never rebase a pushed
  branch; never force-push `main`.
- `.gitignore`: `node_modules/`, `dist/`, `out/`, `projects/`, `.worktrees/`, `spike/out/`, `**/build/`,
  `!apps/desktop/build/` (electron-builder icons and entitlements are source), `**/cache/`, `.venv/`,
  `*.dmg`, `.DS_Store`, `docs/evidence/**/reference/*.mp4`, `docs/reference/`, `native/**/.build/`.

## UI

- React function components, Zustand stores, Tailwind + shadcn/ui. Dark theme by default, matching the
  reference layout (agent panel left, preview top centre, media bin bottom left, timeline bottom,
  inspector right).
- Every async UI action shows progress and maps `VoxError.hint` to a toast.
- A drag sends one op on drop. Sliders and text fields send an op per change with `coalesceKey`
  `<field>:<itemId>`, so one gesture is one undo entry (D-15).
- Keyboard shortcuts per app spec "Main editor".

## Docs

- English. The spec is updated when a phase learns a fact the spec guessed (e.g. pinned version,
  measured latency). Plan logs record what happened; specs record what is true.
