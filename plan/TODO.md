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
- [ ] **Second style reference** (given 2026-10-11): <https://www.tiktok.com/@metro.media.house3/video/7695169259369925908>.
      Phase 07 uses it beside the reel for the style target. Save it as
      `docs/evidence/phase-07/reference/tiktok-2.mp4` (gitignored). The AI never downloads it.
- [ ] **Reference layout screenshot** of the invideo editor at `docs/reference/invideo-layout.png`
      (gitignored; used by the UI review in PROMPT step 7 from phase 08 on).
- [x] **One public YouTube URL** — given 2026-10-11: <https://youtu.be/BveD4v3YwEQ>. you are allowed to use, for GATE 2 (phase 05) and the agent runs
      (phases 12, 13). If none is here when phase 05 starts, the AI proposes public candidates here (your
      own posts first, else videos with a reuse licence) and you confirm one (D-16).
- [x] **One public Instagram reel URL and one public TikTok URL** — given 2026-10-11:
      <https://www.instagram.com/reel/Ddb4orITV_K/>, <https://www.tiktok.com/@ngurahmayun_code/video/7695082402745486593>. you are allowed to use, for GATE 2
      (phase 05) and the quick-clips check at GATE 5 (phase 10b) (D-13). If the Instagram one needs a
      login, say which browser you are logged in with; the cookies opt-in is then tested once. The AI
      proposes candidates the same way if none are given (D-16).
- [x] **Commons contact** — given 2026-10-11; stored only in the local `~/.vox/config.json`. (an email or URL sent in the Wikimedia User-Agent), for phase 05. Use a
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

- [x] ~~**DaVinci Resolve 18.5+**~~ — not installed; owner chose the automated OTIO check instead (D-39).
- Not required (D-16): a second macOS user account or a friend's Mac. Install checks run on your own
  account (automated clean-install test in 09, your E2E run with a fresh `VOX_HOME` at GATE 5, your
  install of the `v1.0.0` `.dmg` from the GitHub Release at v1.0). A friend's install is optional.

## Gates (filled by the AI when reached)

| Gate | Question | Evidence file | Your answer |
|---|---|---|---|
| GATE 1 | Decided by the numbers (D-29): all 9 items pass → whole-sequence render, opaque-sandbox preview, NTSC go, no pre-render cache (fps margin 20.8 %). No answer needed; you may overrule. | `docs/SPIKE_RESULTS.md` | |
| GATE 2 | Engine done-when (D-16). Local parts pass (done-when 9, 10; quick/ingest on a local file). Please answer: (1) the public YouTube, Instagram reel and TikTok URLs you allow (step 14 below); (2) Resolve: does the `.otio` open with clips and layer MOVs (with alpha) in place? attach the screenshot (step 15); (3) the Commons contact (project email or URL), or "none" to keep the 10/min throttle; (4) a login-walled Instagram post URL and the browser you are logged in with, for the cookies opt-in, or "skip". Then the AI runs `scripts/gate2.sh` with the URLs and records the result. | `plan/log/phase-05.md` "Done when"; `docs/evidence/phase-05/14-gate2-summary.json` || 2026-10-11: (1) URLs given (Inputs); (2) no Resolve — use the automated OTIO check (`15-otio-check.json`; Resolve not tested); (3) contact given (local config only); (4) not given. `gate2.sh` 12/12 pass → GATE 2 passed (D-39). |
| GATE 3 | | | |
| GATE 4 | Decided by the numbers (D-35): 119.7 fps drag / 119.7 trim / 119.4 linked in Electron 44.7.0 (bar 50), linked + marquee checks 3/3 → keep `@xzdarcy/react-timeline-editor`. No answer needed; you may overrule. | `docs/evidence/phase-08/A3-timeline-bench-electron.json` | |
| GATE 5 | | | |
| v1.0 | | | |
| GATE 6 | | | |
| GATE 7 | | | |
| GATE 8 | | | |

## Manual steps (filled by the AI)

<!-- format: - [ ] phase NN · step · what to do · where the AI left the instructions -->
- [x] phase 04 · step 15 (optional; needed at GATE 2) (done by gate2.sh 2026-10-11, D-39) · run `vox ingest <project> <url>` once each for one real YouTube URL, the Instagram reel URL and the TikTok URL from "Inputs" above; note any `LOGIN_REQUIRED` or impersonation error · `plan/log/phase-04.md` "MANUAL STEPS", `vox doctor` for tool status
- [x] phase 05 · step 14 · (URLs given 2026-10-11; gate2.sh 12/12 pass) put the URLs in "Inputs" above: one public YouTube video with a person speaking (your own post first; else one whose YouTube page says "Creative Commons Attribution license (reuse allowed)", e.g. a CC Global Summit 2019 keynote listed at <https://creativecommons.org/2019/08/27/now-you-can-watch-the-keynotes-from-ccs-2019-global-summit/>; the AI has not checked a specific video's licence line), one public Instagram reel and one public TikTok video (your own posts are the safe choice; no reuse-licence candidates exist there), optionally a login-walled Instagram post + your logged-in browser. The AI then runs `bash scripts/gate2.sh --youtube <url> --instagram <url> --tiktok <url> [--walled <url>]` · `plan/log/phase-05.md` "MANUAL STEPS"
- [x] phase 05 · step 15 · (no Resolve: replaced by `scripts/otio-check.py`, owner's choice, D-39) after the step-14 URL run, open `docs/evidence/phase-05/reference/GATE2 YouTube-Main.otio` (with its `-layers/` folder) in DaVinci Resolve 18.5+ (File → Import → Timeline); check the clips and the layer MOVs (title, transition, captions, with alpha) sit in place; save a screenshot as `docs/evidence/phase-05/15-resolve.jpg` (≤ 500 kB) and say "ok" or what is wrong. If Resolve rejects the file, say so: the AI then adds the FCPXML fallback (D-10) · `plan/log/phase-05.md` "MANUAL STEPS"
- [x] phase 05 · GATE 2 · Commons contact (given; local config only): a project email or URL for the Wikimedia User-Agent (`contact` in `~/.vox/config.json`), or "none" · TODO "Inputs" above
- [ ] phase 08 · step 10 (optional; does not block anything) · open the skeleton app once the Gatekeeper way: copy `apps/desktop/dist/Vox Studio-0.0.0-arm64.dmg` (build it with `pnpm -C apps/desktop dist`) to Downloads, open it, drag Vox Studio to Applications, double-click it; if macOS refuses, use System Settings → Privacy & Security → "Open Anyway"; note any other dialog · `plan/log/phase-08.md` "Manual steps"
- [ ] phase 09 · step 7 (optional; does not block anything) · test the `/usr/local/bin` target of the menu "Vox Studio → Install vox Command…": build with `pnpm dist`, open the app from `apps/desktop/dist/mac-arm64/`, choose "For all users (/usr/local/bin)", enter your admin password in the macOS prompt, then run `vox --version` in a new terminal; say "ok" or paste the error · `plan/log/phase-09.md` "MANUAL STEPS"
- [ ] phase 09 · step 9b (optional; does not block anything) · open the built app once through "Open Anyway" on your own account: copy `apps/desktop/dist/Vox-Studio-0.0.0-arm64.dmg` to Downloads, open it, drag Vox Studio to Applications, double-click it; when macOS refuses, use System Settings → Privacy & Security → "Open Anyway"; save screenshots of both dialogs as `docs/evidence/phase-09/gatekeeper-1.png` and `gatekeeper-2.png` for the README · `plan/log/phase-09.md` "MANUAL STEPS"
- [ ] phase 10a · step 1 (required: UI gate, done-when 3) · put the invideo editor screenshot at `docs/reference/invideo-layout.png` (gitignored), then send `done: 10a layout screenshot`; the AI compares `docs/evidence/phase-10a/10a-*.png` with it, fixes HIGH findings, re-runs Verify and merges · `plan/log/phase-10a.md` "MANUAL STEPS"
