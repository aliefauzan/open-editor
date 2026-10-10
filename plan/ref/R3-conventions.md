# R3 — Conventions

## Language and tooling

- TypeScript strict, ESM, `moduleResolution: NodeNext`. Node 24 for dev and CLI; the app runs the CLI
  with Electron as Node (`ELECTRON_RUN_AS_NODE=1`), so code must also run on Electron's Node version.
- pnpm workspaces; `packageManager` pinned. No global installs in scripts.
- zod for every boundary: op args, tool args, IPC args, Python bridge, config, style/template files.
- Lint: ESLint (typescript-eslint) + Prettier. Import boundaries per R1.
- Python: uv project in `py/`, Python 3.12, run as `uv run --frozen --project py python -I -m vox_py.<tool>`
  (in the packaged app also with `UV_PROJECT_ENVIRONMENT` and `UV_CACHE_DIR` in the tools folder).
  Never bare `python3` (on this Mac it can exit 69 on the Xcode licence check). Python formatting: ruff.

## Tests

- vitest for TS (`pnpm test`), pytest for `py/` (`uv run --project py pytest`).
- Write the failing test first. A bug fix starts with a test that reproduces it.
- Test names say the behaviour: `trimItem keeps linked A1 in sync at 24 fps`.
- Slow tests (render, transcribe, Electron E2E) are tagged and run with `pnpm test:slow`; CI runs fast
  tests on every push and slow tests on demand.
- Never mock the thing under test. Mock providers with `MockLanguageModelV4` from `ai/test`.
- Tests never touch the owner's data: every test, E2E run and Verify block sets `VOX_PROJECTS_DIR`,
  `VOX_HOME` and `VOX_TOOLS_DIR` to `mktemp -d` folders (engine spec "Project folder"). Keychain tests use
  service `Vox Studio Test` and delete their items.
- Fixtures are generated, not downloaded (R7). The only exceptions are the checked-in files listed in
  R7: two CC0 portraits (committed once, with their licences) and transcripts generated once by phase 04.

## Errors

- Throw `VoxError { code, message, hint, cause? }` from `engine/src/errors.ts`. `hint` tells the user
  what to do next. `cause` for external tools holds the last 40 stderr lines, redacted.
- No silent fallbacks: if a stage cannot do its job it fails with a code, or reports a skipped step.

## External processes

- Spawn with an argument array, never through a shell. No string-built command lines.
- ffmpeg/ffprobe on untrusted input always get `-format_whitelist` and `-protocol_whitelist file,pipe`.
- yt-dlp always goes through the filtering proxy with the flags in the engine spec.
- Every child process gets an `AbortSignal`; cancel kills it.

## Times and ids

- Times are integer milliseconds snapped to the sequence's frame grid. Never floats in the model.
- Ids are short, stable, prefixed (`m_`, `seq_`, `it_`, `run_`); never reused.
- Track ids are the exception: `V1..Vn` and `A1..An`, unique within a sequence, as the engine spec
  fixes them (the clipper and `placeClip` default to `A1`).

## Files and paths

- Every project-relative path goes through `engine/src/paths.ts`. No ad-hoc `path.join` on user input.
- Writes that matter use temp file + `fsync` + rename (see engine "Write order").
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
- Keyboard shortcuts per app spec "Main editor".

## Docs

- English. The spec is updated when a phase learns a fact the spec guessed (e.g. pinned version,
  measured latency). Plan logs record what happened; specs record what is true.
