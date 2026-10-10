# TODO — owner only

Things the AI cannot do: decisions, real accounts, a second machine or account, and visual approval.
The AI adds items here when a phase reaches a MANUAL STEP or a GATE. Tick them off and tell the AI
"done: <item>" to resume.

## Before phase 00

- [x] **Approve the specs** (Revision 3) in `docs/superpowers/specs/`. Approved 2026-10-10 (D-10).
- [x] **Licence** for the repo: MIT (D-10).
- [x] **Projects folder**: `~/Movies/Vox Studio/` (D-10). Change it later with `projectsDir` in
      `~/.vox/config.json` or `VOX_PROJECTS_DIR`.
- [ ] **Repo hosting**: create a GitHub repo now or later? The `.dmg` update check (phase 09) needs a
      repo with Releases; until then the check is off. Tell the AI the `owner/repo` name when it exists.
- [ ] **Commons contact** (an email or URL sent in the Wikimedia User-Agent). Use a project address,
      not a personal one, since it goes to a third party. Needed by phase 05.

## Inputs the AI needs during the run (give them early)

- [ ] **Local tools on the M5** (phase 00 onward; `vox doctor` checks them in 04): Node 24 + pnpm,
      Xcode command-line tools 26 or newer (`xcode-select --install`; the macOS 26 SDK builds the
      Apple on-device helper in phase 11), Homebrew, then `brew install ffmpeg yt-dlp deno uv`.
- [ ] **Reference reel** `.mp4` at `docs/evidence/phase-07/reference/reel.mp4` (gitignored; phase 07
      step 0). The AI never downloads it.
- [ ] **Reference layout screenshot** of the invideo editor at `docs/reference/invideo-layout.png`
      (gitignored; used by the UI review in PROMPT step 7 from phase 08 on).
- [ ] **One public YouTube URL** you are allowed to use, for GATE 2 (phase 05) and the agent runs
      (phases 12, 13).

## Accounts and keys (needed by phase 11–13; not before)

- [ ] OpenRouter account + key with a small credit limit. You enter it yourself in Settings or
      `vox config providers add`; the AI never types real keys.
- [ ] Ollama installed with one local model for plan mode (the model named in `evals/models.json`,
      chosen in phase 12).
- [ ] Optional: an Anthropic key (Claude), OpenCode Zen key, a local 9router gateway, or OpenAI /
      Gemini keys, for probe tests and `pnpm eval --provider <id>`. Each one you add is tested.
- [ ] **Apple Intelligence turned on** on the M5 (System Settings → Apple Intelligence & Siri;
      macOS 26+), so the Apple on-device provider can be probed (phase 11) and checked in the app
      (phase 13). Optional: without it those checks are skipped with the reason.

## Machines

- [ ] A **second macOS user account** on the M5 (clean, no Homebrew in PATH) for the `.dmg` smoke
      tests (skeleton in 08, setup in 09, full editor in 10b).
- [ ] **DaVinci Resolve 18.5+** (free) installed, for the OTIO check (phase 05, GATE 2).
- [ ] A **friend's Apple Silicon Mac** (macOS 14+) for the v1.0 install test (phase 13).

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
