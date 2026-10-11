# yt-dlp fixtures (phase 04, D-13)

Offline inputs for the yt-dlp tests; no network is used.

- `*.stderr.txt`: yt-dlp stderr for a login-walled Instagram post, a private TikTok, an Instagram
  rate limit, an unsupported page and a server error. The `ERROR:` lines are the exact messages of
  yt-dlp 2026.07.04 (`extractor/instagram.py`, `extractor/tiktok.py`, `_login_hint` in
  `extractor/common.py`); post ids are made up.
- `reel-1080x1920.info.json`: format list of a vertical reel (480p … 1440×2560 video-only, one audio,
  one progressive). The engine's format flags must pick the 1080×1920 stream plus audio.
- `carousel-3.info.json`: a three-video post; only the first is taken and the count (3) is reported.
  Load it with `--no-clean-info-json` (a cleaned info file has no entries).
