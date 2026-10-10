# TODO — owner only

Things the AI cannot do: decisions, real accounts, and visual or audio approval.
The AI adds items here when a phase reaches a MANUAL STEP or a GATE. Tick them off and tell the AI
"done: <item>" to resume.

## Before phase 00

- [x] **Approve the specs** (Revision 3) in `docs/superpowers/specs/`. Approved 2026-10-10 (D-10).
- [x] **Licence** for the repo: MIT (D-10).
- [x] **Projects folder**: `~/Movies/Vox Studio/` (D-10). Change it later with `projectsDir` in
      `~/.vox/config.json` or `VOX_PROJECTS_DIR`.
- [x] **Repo hosting**: `aliefauzan/open-editor` on GitHub (D-12). The `.dmg` update check (phase 09)
      uses its Releases.
- [x] **Plan review 4 answers** (2026-10-10, D-16): the M5 runs macOS 27.0.1 with Xcode 27.0 (macOS 27
      SDK); the AI
      chooses the rest; no second account or friend's Mac is required, as long as people can clone the
      repo from GitHub or install the shared `.dmg`.

## Inputs the AI needs during the run (give them early)

- [x] **Local tools on the M5** (checked 2026-10-10): macOS 27.0.1, Xcode 27.0 (macOS 27 SDK), Node
      24.14, pnpm 12.0, Homebrew 7.0, ffmpeg 8.1.2, yt-dlp 2026.07.04, deno 2.9.5, uv 0.11.19.
- [x] **Xcode licence accepted** (2026-10-10): Swift 6.4, macOS 27.0 SDK; a FoundationModels test
      program compiles and reports the system model `available`.
- [ ] **Reference reel** `.mp4` at `docs/evidence/phase-07/reference/reel.mp4` (gitignored; phase 07
      step 0). The AI never downloads it.
- [ ] **Reference layout screenshot** of the invideo editor at `docs/reference/invideo-layout.png`
      (gitignored; used by the UI review in PROMPT step 7 from phase 08 on).
- [ ] **One public YouTube URL** you are allowed to use, for GATE 2 (phase 05) and the agent runs
      (phases 12, 13). If none is here when phase 05 starts, the AI proposes public candidates here (your
      own posts first, else videos with a reuse licence) and you confirm one (D-16).
- [ ] **One public Instagram reel URL and one public TikTok URL** you are allowed to use, for GATE 2
      (phase 05) and the quick-clips check at GATE 5 (phase 10b) (D-13). If the Instagram one needs a
      login, say which browser you are logged in with; the cookies opt-in is then tested once. The AI
      proposes candidates the same way if none are given (D-16).
- [ ] **Commons contact** (an email or URL sent in the Wikimedia User-Agent), for phase 05. Use a
      project address, not a personal one, since it goes to a third party. Without it Commons requests
      are throttled to 10/min, so phase 05 does not wait for it (D-12).
- [ ] **Your ears** at GATE 3 (phase 07): listen to the five `LISTEN.md` timecodes of the side-by-side
      clip and say if any sound is wrong (D-14).

## Accounts and keys (needed by phase 11–13; not before)

- [ ] OpenRouter account + key with a small credit limit. You enter it yourself in Settings or
      `vox config providers add`; the AI never types real keys.
- [ ] Ollama installed with one local model for plan mode (the model named in `evals/models.json`,
      chosen in phase 12).
- [ ] Optional: an Anthropic key (Claude), OpenCode Zen key, a local 9router gateway, or OpenAI /
      Gemini keys, for probe tests and `pnpm eval --provider <id>`. Each one you add is tested.
- [x] **Apple Intelligence turned on** on the M5 (checked 2026-10-10: `available`) (System Settings → Apple Intelligence & Siri;
      macOS 26+), so the Apple on-device provider can be probed (phase 11) and checked in the app
      (phase 13). Optional: without it those checks are skipped with the reason.

## Machines

- [ ] **DaVinci Resolve 18.5+** (free) installed, for the OTIO check (phase 05, GATE 2).
- Not required (D-16): a second macOS user account or a friend's Mac. Install checks run on your own
  account (automated clean-install test in 09, your E2E run with a fresh `VOX_HOME` at GATE 5, your
  install of the `v1.0.0` `.dmg` from the GitHub Release at v1.0). A friend's install is optional.

## Gates (filled by the AI when reached)

| Gate | Question | Evidence file | Your answer |
|---|---|---|---|
| GATE 1 | | | |
| GATE 2 | | | |
| GATE 3 | | | |
| GATE 4 | | | |
| GATE 5 | | | |
| v1.0 | | | |
| GATE 6 | | | |
| GATE 7 | | | |
| GATE 8 | | | |

## Manual steps (filled by the AI)

<!-- format: - [ ] phase NN · step · what to do · where the AI left the instructions -->
