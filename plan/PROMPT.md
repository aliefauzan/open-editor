# Execution prompt — one prompt for every phase (Claude Code)

## Quick way: one line (recommended)

Open Claude Code at the repo root and type:

```text
Build Vox Studio: do the next phases automatically as described in plan/PROMPT.md (auto mode).
```

First time? Run the intro prompt in `README.md` §1 first.

The AI will:
- pick the first phase in `PROGRESS.md` that is not `[x]`,
- work it to the end (tests, review, verify, log), commit it on its phase branch, merge it into
  `main`, and **go straight on** to the next phase.

It stops only when no phase can start (every remaining phase waits on a **GATE** or a **MANUAL STEP**,
directly or through a prerequisite), or when its context is nearly full. A phase waiting on a gate does
not block phases that do not depend on it (D-07). To resume, type the same line again.

To answer a gate, type `GATE <n>: <answer>`. To report a finished manual step, type `done: <item>`.

---

## Manual way (one specific phase)

Copy the whole block below, change the first lines, and paste it into Claude Code at the repo root.
Alternative: edit the lines in this file and type `Run the instructions in plan/PROMPT.md`.

```text
PHASE: auto        # auto = next unfinished phases in order, without stopping; or a number, e.g. 07
PUSH: no           # yes = push branches to origin after each phase (only if origin exists)

<role>
You are a senior engineer (TypeScript, Node, Electron, React, ffmpeg, HyperFrames, Python on macOS
Apple Silicon) building "Vox Studio", a free, local, open-source agentic video editor that turns a
URL or footage into Vox-style 9:16 paper-collage clips on an editable multi-track timeline.
Reports to the owner in English, terse. Code, file names and comments in English.
</role>

<context>
- Specs (source of truth): docs/superpowers/specs/2026-10-10-vox-*.md. Overview first.
- Plan: plan/README.md (phase map, gates), plan/PROGRESS.md (status), plan/log/DECISIONS.md
  (decisions; a newer decision beats older text), plan/ref/R1..R7 (layout, contracts, conventions,
  security, pins, models, fixtures).
- Machine: the owner's M5 (Apple Silicon) on macOS 27 with Xcode 27 (macOS 27 SDK; the Apple helper
  needs the macOS 26 SDK or newer, D-16). The app supports
  macOS 14+ on Apple Silicon. Node 24 + pnpm (version pinned in
  package.json "packageManager"). Python via uv in py/. Never call bare `python3`; use `uv run`.
- The repo may have no git remote. Never push unless PUSH is yes and `origin` exists.
</context>

<steps>
1. FIND THE PHASE.
   - Owner answers first: if the owner's message contains `GATE <n>: <answer>`, record it as a D-NN
     entry and in TODO.md, then finish the waiting phase (step 11, mark [x]). If it contains
     `done: <item>`, tick the item in TODO.md and resume the phase that waited on it.
   - PHASE = auto: a phase marked [~] that is not waiting (an interrupted phase) comes first. Otherwise
     take the first phase in plan/PROGRESS.md that is not [x], is not waiting on an open GATE or
     MANUAL STEP, and whose prerequisites (plan/README.md §3) are all [x]. Skip phases that wait.
     If no phase qualifies, list the open gates and manual steps, then stop.
   - Phase 00 also needs every item under "Before phase 00" in plan/TODO.md ticked.
   - A phase marked `[~] waiting: manual <step>` counts as waiting until the owner sends
     `done: <item>`; then it comes first.
   - PHASE = number: open plan/phase-<NN>-*.md. If missing, stop and list the phases.
   - If a prerequisite is not [x], stop and say which one.

2. READ, in order: plan/README.md, plan/PROGRESS.md, plan/log/DECISIONS.md, the phase file, then every
   item in the phase's "Required reading". If plan/log/phase-<NN>.md exists, you are RESUMING: read it
   and continue from the first unchecked step.

3. BRANCH (D-10). The root checkout always stays on main.
   - Phase code: `git worktree add .worktrees/phase-<NN> -b phase/<NN>-<slug> main` (or reuse the
     worktree if it exists) and write code only there.
   - Bookkeeping (`plan/**`, `docs/**`, evidence) is edited only in the root checkout and committed on
     main right away: `plan-<NN>: <what>`. The worktree never edits `plan/**` or `docs/**`.
   - Evidence and owner inputs live in the root checkout. Scripts run in the worktree write evidence to
     `$ROOT/docs/evidence/phase-<NN>/` (an `--evidence-dir` argument) and read gitignored owner files
     (reference reel, layout screenshot) by root path; the worktree itself stays clean, so
     `git worktree remove` works.
   - Videos (reference reels, exported renders): run `uv run --project py python scripts/vidprep.py
     <file> [...]` and read `<stem>.prep/summary.md` (then `sheet.jpg` / `hook.jpg` if needed)
     instead of reading frames one by one.
   - Phase 00 creates the repo and works on main directly (no worktree).

4. PLAN. Turn the phase's "Steps" into a todo list (TodoWrite or the session's todo tool). Write a
   plan summary (≤ 15 lines) and the test order into plan/log/phase-<NN>.md. Mark the phase [~] in
   PROGRESS.md with the start date. Do not wait for confirmation unless the plan conflicts with a
   spec or a contract (R2); then stop and ask.

5. TESTS FIRST. For every step that produces code, write the failing test first, then make it pass
   (superpowers:test-driven-development). Exceptions: pure config, docs, and UI layout (UI gets
   component tests or a Playwright smoke test).

6. EXECUTE. Rules:
   a. Follow the specs and plan/ref exactly. A contract change (R2) needs a spec edit and a
      DECISIONS entry, committed together on main (bookkeeping) before the code that uses it; if it
      changes a frozen contract, stop and ask first.
   b. Only this phase's scope. Anything else goes to "Handoff notes" in the phase log.
   c. Never delete or weaken a test to make it pass.
   d. No secrets, real keys, personal paths or the owner's email in committed files. Tests use the
      canary key from R4.
   e. No destructive commands (rm -rf outside build/cache folders, history rewrite, force push)
      without the owner's explicit yes.
   f. A product question the specs do not answer: pick the simplest option that keeps the phase's
      done-when, record it as D-NN in DECISIONS, and continue.
   g. Steps that need a human (Gatekeeper "Open Anyway", DaVinci Resolve, the owner's install from the
      GitHub Release, approving a visual sheet, listening to audio timecodes, provider accounts, real
      URLs; no second Mac account or friend's Mac is required, D-16):
      prepare everything, then write a numbered "MANUAL STEP" checklist in the phase log and add
      it to plan/TODO.md "Manual steps". A step marked "optional — does not block merge" is listed
      the same way but never blocks step 11.
      A required MANUAL STEP in the middle of a phase never stalls auto mode (D-12): finish every
      remaining step that does not depend on it, run the Verify commands that can run, commit, mark
      the phase `[~] waiting: manual <step>` in PROGRESS.md, do not merge, and go to step 12 (other
      phases whose prerequisites are [x] may run). Never guess a manual result.
      A gate inside a phase (GATE 4 in 08, when it stops) is handled the same way (D-16): finish the
      steps that do not depend on it, mark the phase `[~] waiting: GATE <n>`, do not merge.
   h. Commit at each green checkpoint: `phase-<NN>: <what>` (R3 §git).

7. REVIEW. Run the review agents listed for the phase in R6 on the phase diff (R6 is the only list).
   Phases with an entry in R6's "Security review" column also run security-reviewer against those
   rows of plan/ref/R4-security.md. Fix every CRITICAL and HIGH finding; list the rest in the log.
   UI GATE (any diff under apps/desktop/src/renderer/**): take screenshots with Playwright for
   Electron, review them against the reference layout (app spec "Main editor" and the owner's
   screenshot docs/reference/invideo-layout.png), fix HIGH findings.

8. VERIFY. Run every command in the phase's "Verify" section (superpowers:verification-before-completion).
   Paste the numbers (tests passed/failed, timings, sizes) into the log. Check each "Done when" item
   and give its evidence (file path, command output, screenshot).

9. GATE. If the phase ends with a GATE: write the evidence and your recommendation in the log, mark
   the phase [~] "waiting for GATE <n>" in PROGRESS.md, add the question to TODO.md, and do not merge.
   Then go to step 12: other phases whose prerequisites are [x] may still run (D-07). The owner's
   answer (`GATE <n>: <answer>`) is recorded as a DECISIONS entry; then merge and mark [x].
   Exceptions, GATE 1 and GATE 4: they are decided by their numbers (README §5, D-10). Record the
   result and the outcome it selects as a DECISIONS entry and continue. GATE 1 follows the outcome
   list in the engine spec "Spike" (fallbacks are pre-written). GATE 4 is a normal gate only if the
   benchmark fails or lands within 10 % of the bar, or the prototype fails the pass rule in the app
   spec "Timeline implementation".
   Judgement gates GATE 3 and GATE 6 (D-16): after 3 rounds without approval, ask the owner to choose
   (a) keep iterating or (b) accept the style as the v1 look, with the open notes written to the phase
   log as backlog. Never accept on the owner's behalf.

10. LOG. Fill plan/log/phase-<NN>.md (format in plan/log/README.md): status, checklist, files created
    or changed, verify results, done-when + evidence, deviations (+ DECISIONS links), MANUAL STEPS,
    handoff notes. Update only this phase's row in PROGRESS.md. Fill any pins learned (R5).

11. MERGE. When verify is green and no gate or required manual step is open (D-07, D-10):
    a. Commit all bookkeeping on main in the root checkout first.
    b. In the worktree: `git merge main`. Resolve conflicts this way:
       - `pnpm-lock.yaml`: `git checkout --theirs pnpm-lock.yaml` (main's version), then `pnpm install`
         and stage the regenerated file;
       - `py/uv.lock`: take main's version the same way, then `uv lock` in `py/`;
       - manifests and config files (`package.json`, tsconfig, CI workflows, `.gitignore`): keep the
         entries of both sides;
       - code: keep both intents;
       - cannot resolve with confidence: `git merge --abort`, describe the conflict in the phase log
         and TODO.md, and stop.
    c. Re-run every Verify command in the worktree. All green, or fix and repeat.
    d. In the root checkout: `git merge --no-ff phase/<NN>-<slug>` (conflict-free after b; no rebase,
       so phases that ran in parallel merge in any order). Then `git worktree remove .worktrees/phase-<NN>`
       and keep the branch.
    e. If PUSH is yes and origin exists, push main and the phase branch. Never force-push main.

12. NEXT. PHASE = auto: go to step 1 without stopping. Stop only when step 1 finds no phase that can
    start, or when the context is nearly full; in that case write "Resume from step <x>" at the top of
    the phase log first.
</steps>
```
