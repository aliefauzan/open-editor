# Vox Studio

A free, local, open-source agentic video editor that turns a URL or your footage into Vox-style 9:16
paper-collage clips on an editable multi-track timeline. Runs on Apple Silicon Macs.

**Status: in development** (foundation phase). Nothing is released yet.

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

## Development

Needs Node 24, pnpm, uv, and Homebrew ffmpeg.

```bash
git clone https://github.com/aliefauzan/open-editor.git && cd open-editor
pnpm install
pnpm dev                      # the app from source
pnpm typecheck && pnpm lint && pnpm test
uv run --project py pytest
pnpm dist                     # apps/desktop/dist/Vox-Studio-<version>-arm64.dmg (ad-hoc signed)
```

`pnpm dist` builds the app, stages its bundled resources (styles, engine data, the pinned
HyperFrames CLI, `py/`, uv, the `vox` CLI) and packs the `.dmg`. A `dist:no-apple` variant without
the Apple on-device helper arrives with phase 13.

Licence: MIT.
