# Vox Studio

A free, local, open-source agentic video editor that turns a URL or your footage into Vox-style 9:16
paper-collage clips on an editable multi-track timeline. Runs on Apple Silicon Macs.

**Status: in development** (foundation phase). Nothing is released yet.

- Specs: [`docs/superpowers/specs/`](docs/superpowers/specs/)
- Build plan and progress: [`plan/`](plan/README.md), [`plan/PROGRESS.md`](plan/PROGRESS.md)

## Development

Needs Node 24, pnpm, uv, and Homebrew ffmpeg.

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
uv run --project py pytest
```

Licence: MIT.
