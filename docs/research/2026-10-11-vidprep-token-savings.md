# vidprep: read videos for about 2-3K tokens (2026-10-11)

Owner request: cut the tokens agents spend studying videos (reference study, export checks).

## Idea

An Instagram reel by Josh Blatchford (@joshuablatch, reel `DeR8ZyWxve0`) shows the approach. Before
Claude looks at a video, the Mac prepares it with free local tools: Spotlight to find files, Apple
Vision for on-screen text, Whisper for the transcript, ffmpeg for one contact sheet. Claude then
reads a one-page summary and at most two images instead of raw frames. He reports about 50K tokens
per short video before and about 3K after.

## What we built

`scripts/vidprep.py` (usage in its docstring):

    uv run --project py python scripts/vidprep.py <video-or-url> [...]

It writes `<stem>.prep/` with `summary.md` (read first), `summary.json`, `sheet.jpg` (a frame from
the middle of each shot, timestamped, at most 16), `hook.jpg` (first 2 s) and `transcript.txt`.
It reuses `vox_py.transcribe` (VAD, then mlx-whisper), `vox_py.audioqa_dsp` (LUFS) and Apple Vision
(`VNRecognizeTextRequest`). One-word OCR lines that are spoken words are dropped as burned-in
captions. Images are sized to stay under the 1568 px edge and 1.15 MP caps, so each costs at most
about 1.5K tokens.

## Measured

| Video | Duration, shape | Scene cuts | Prepared | Raw (1 full frame / 2 s) | Wall time |
|---|---|---|---|---|---|
| The reel | 1:11, 1440x2560 | 2 | ~2.8K tokens | ~55K tokens | 44 s |
| metro.media.house3 TikTok | 0:59, 1024x576 | 24 | ~2.3K tokens | ~24K tokens | under 1 min |

Token counts are estimates (pixels / 750 for images, characters / 4 for text).

## Limits

- Scene cuts come from ffmpeg's `scene` score (default 0.3). A handheld shot of a screen gives
  false cuts; a slow crossfade can hide a real one.
- OCR reads burned-in captions too. Only one-word caption lines are filtered.
- Sheet frames are shot midpoints, so a very short shot can be missed when there are more than 16.
