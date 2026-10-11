# Vox Studio

A free, local, open-source agentic video editor that turns a URL or your footage into Vox-style 9:16
paper-collage clips on an editable multi-track timeline. Runs on Apple Silicon Macs.

**Status: v1.0.0.** Download the `.dmg` from the
[GitHub Releases](https://github.com/aliefauzan/open-editor/releases) page.

- Specs: [`docs/superpowers/specs/`](docs/superpowers/specs/)
- Build plan and progress: [`plan/`](plan/README.md), [`plan/PROGRESS.md`](plan/PROGRESS.md)

## Install from the .dmg

Needs an Apple Silicon Mac with macOS 14 or later.

1. Open `Vox-Studio-<version>-arm64.dmg` and drag **Vox Studio** to **Applications**.
2. Open Vox Studio. The app is ad-hoc signed, not notarized, so macOS blocks the first launch
   ("Apple could not verify…"). Click **Done**, open **System Settings → Privacy & Security**, scroll
   to the message about Vox Studio and click **Open Anyway**, then confirm with your password or
   Touch ID. macOS remembers this choice. (Screenshots of these dialogs will be added here.)
   - Alternative in Terminal: `xattr -dr com.apple.quarantine "/Applications/Vox Studio.app"`, then
     open the app normally.
   - The `.dmg` itself may also show the warning when you open it; the same **Open Anyway** step
     applies.
3. The setup screen lists each tool with its size and licence. Click **Install all**: Vox Studio
   downloads its pinned tools (uv, deno, yt-dlp, the Python environment, Chrome for rendering) into
   `~/Library/Application Support/Vox Studio/tools` and checks each file's SHA-256. Nothing is written
   inside the app. The editor opens meanwhile; steps that wait for a tool say so.
4. Optional: **Vox Studio → Install vox Command…** links the `vox` command line to the app
   (`~/.local/bin/vox`, or `/usr/local/bin/vox` with an administrator password).

### Homebrew and ffmpeg

Vox Studio uses ffmpeg from Homebrew and never downloads it. If Homebrew is missing, the setup
screen shows both commands with copy buttons. Run them in Terminal, then click **Check again**:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install ffmpeg
```

Installing Homebrew needs an administrator password. Homebrew prints two `eval` lines at the end;
run them so that `brew` is on your `PATH`.

## Quick clips and the agent

Paste a link (YouTube, Instagram, TikTok) or choose a video file on the start screen and click
**Make clips**: Vox Studio downloads, transcribes and cuts captioned 9:16 clips, one sequence tab
each. This needs no AI model.

The agent panel (left) edits with a language model you choose in **Settings** (on the start screen and
in the editor's top bar):

- **Local, no key**: Apple on-device (macOS 26+ with Apple Intelligence on) or Ollama
  (`ollama pull <model>`; plan mode suits small models). Project content stays on your Mac.
- **Cloud, your key**: OpenRouter, OpenCode Zen, Claude, OpenAI, Gemini, or any OpenAI-compatible
  server (base URL). The key goes to the macOS Keychain; Settings only ever shows it masked. Project
  content (transcripts, frames, your messages) is sent to that provider when the agent runs.

Press **Test** on a model: a role (editor, fast, vision) can be given only to a model that passed
its checks. Each run has a budget (default $3, steps capped); at the cap the agent asks before it
goes on. Every agent edit is one undoable change set, and **Undo this run** takes a whole run back.

For Instagram or TikTok links that need a login, **Settings → Tools → Use browser cookies** lets
yt-dlp read the cookies of the browser you are logged in with. It is off by default.

## Development

Needs Node 24, pnpm, uv, and Homebrew ffmpeg.

```bash
git clone https://github.com/aliefauzan/open-editor.git && cd open-editor
pnpm install
pnpm dev                      # the app from source
pnpm typecheck && pnpm lint && pnpm test
uv run --project py pytest
pnpm dist                     # apps/desktop/dist/Vox-Studio-<version>-arm64.dmg (ad-hoc signed)
pnpm dist:no-apple            # the same without the Apple on-device helper (no macOS 26+ SDK)
bash scripts/fresh-clone-check.sh   # clone → install → dist → vox self-test on the built app
```

`pnpm dist` builds the app, stages its bundled resources (styles, engine data, the pinned
HyperFrames CLI, `py/`, uv, the `vox` CLI, the agent's workflow prompts) and packs the `.dmg`. It also
builds and signs `vox-apple-llm`, the Apple on-device model helper, which needs Xcode with the macOS 26
SDK or newer (accept the Xcode licence once with `sudo xcodebuild -license`); without that SDK
`pnpm dist` stops and says so. `pnpm dist:no-apple` builds without the helper: Settings then hides
the Apple provider and `vox self-test` reports the helper as `notBuilt`.

Licence: MIT.
