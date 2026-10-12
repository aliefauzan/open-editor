"""Grain of a reference video: the noise level of its flat mid-tone areas (styles spec Part C, D-93).

Run as `python -I -m vox_py.grain`. Request: `{ videoPath, atMs, ffmpeg?, ffprobe?,
formatWhitelist?, shortSide? }`. ffmpeg decodes one frame per time in `atMs` with its short side
scaled to `shortSide` (default 720, so references of any size compare). On each frame's luma the
noise is estimated with Immerkaer's Laplacian-difference mask (`sigma = sqrt(pi / 2) / 6 *
mean |I * N|`) over the flat mid-tone pixels only: luma 40-215 (grain is clipped in black and
white) and a local gradient in the lower half of those pixels (edges and texture are not noise).

Result (`py/tests/schemas/grain.result.json`): `sigma` = the median over the frames that had
enough flat pixels (8-bit levels at `shortSide`), `frames` = that number of frames, and
`perFrame` = each frame's estimate (null when the frame had too few flat pixels).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from . import _tool
from .facetrack import probe, scaled_size
from .palette import MAX_FRAMES, frame_at

REQUEST: _tool.Spec = {
    "videoPath": (str, True),
    "atMs": (list, True),
    "ffmpeg": (str, False),
    "ffprobe": (str, False),
    "formatWhitelist": (str, False),
    "shortSide": (int, False),
}

# luma range where grain is not clipped
LOW, HIGH = 40.0, 215.0
# flat pixels: local gradient at or below this percentile of the mid-tone pixels
FLAT_PERCENTILE = 50
# a frame needs this many flat pixels for an estimate
MIN_PIXELS = 2000


def noise_sigma(luma: np.ndarray) -> float | None:
    """Noise standard deviation (8-bit levels) of the flat mid-tone pixels of one luma frame."""
    img = luma.astype(np.float64)
    if img.shape[0] < 3 or img.shape[1] < 3:
        return None
    a, b, c = img[:-2, :-2], img[:-2, 1:-1], img[:-2, 2:]
    d, e, f = img[1:-1, :-2], img[1:-1, 1:-1], img[1:-1, 2:]
    g, h, i = img[2:, :-2], img[2:, 1:-1], img[2:, 2:]
    response = np.abs(a - 2 * b + c - 2 * d + 4 * e - 2 * f + g - 2 * h + i)
    gradient = np.hypot(f - d, h - b)
    mid = (e > LOW) & (e < HIGH)
    if int(mid.sum()) < MIN_PIXELS:
        return None
    flat = mid & (gradient <= np.percentile(gradient[mid], FLAT_PERCENTILE))
    if int(flat.sum()) < MIN_PIXELS:
        return None
    return float(math.sqrt(math.pi / 2) * response[flat].mean() / 6)


def luma_of(rgb: np.ndarray, w: int, h: int) -> np.ndarray:
    px = rgb.astype(np.float64)
    return (0.299 * px[:, 0] + 0.587 * px[:, 1] + 0.114 * px[:, 2]).reshape(h, w)


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    path: Path = _tool.existing_file(req["videoPath"])
    at = req["atMs"]
    if (
        not at
        or len(at) > MAX_FRAMES
        or not all(isinstance(t, int) and not isinstance(t, bool) and t >= 0 for t in at)
    ):
        raise _tool.ToolError(
            "INVALID_REQUEST", f"atMs must be 1 to {MAX_FRAMES} whole milliseconds >= 0"
        )
    ffmpeg = req.get("ffmpeg", "ffmpeg")
    ffprobe = req.get("ffprobe", "ffprobe")
    formats = req.get("formatWhitelist", _tool.DEFAULT_FORMAT_WHITELIST)
    short_side = _tool.int_at_least(req, "shortSide", 720, 160, 1080)

    width, height, _ = probe(path, ffprobe, formats)
    w, h = scaled_size(width, height, short_side)
    per_frame: list[float | None] = []
    for k, t in enumerate(at):
        px = frame_at(path, ffmpeg, formats, t, w, h)
        sigma = noise_sigma(luma_of(px, w, h)) if px is not None else None
        per_frame.append(None if sigma is None else round(sigma, 3))
        _tool.progress((k + 1) / len(at), f"grain frame {k + 1} of {len(at)}")
    known = [s for s in per_frame if s is not None]
    if not known:
        raise _tool.ToolError("MEDIA_UNREADABLE", "no frame had flat mid-tone areas to measure")
    return {"sigma": round(float(np.median(known)), 3), "frames": len(known), "perFrame": per_frame}


if __name__ == "__main__":
    _tool.main(handle)
