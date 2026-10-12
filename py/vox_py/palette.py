"""Colour palette of a reference video: k-means over keyframes (styles spec Part C, plan phase 15).

Run as `python -I -m vox_py.palette`. Request: `{ videoPath, atMs, ffmpeg?, ffprobe?,
formatWhitelist?, k?, shortSide? }`. ffmpeg decodes one frame per time in `atMs` with its short
side scaled to `shortSide` (default 64); k-means (k = 8 by default, k-means++ start with a fixed
seed, so the result is repeatable) runs on the RGB pixels of all keyframes together.

Result (`py/tests/schemas/palette.result.json`): `colors` = `{ hex, rgb, share, lightness,
saturation }[]` sorted by share (largest first; empty clusters are left out), and `frames` = the
number of keyframes read.
"""

from __future__ import annotations

import colorsys
import subprocess
from pathlib import Path

import numpy as np

from . import _tool
from .facetrack import probe, scaled_size

REQUEST: _tool.Spec = {
    "videoPath": (str, True),
    "atMs": (list, True),
    "ffmpeg": (str, False),
    "ffprobe": (str, False),
    "formatWhitelist": (str, False),
    "k": (int, False),
    "shortSide": (int, False),
}

MAX_FRAMES = 200
ITERATIONS = 40
SEED = 0


def frame_at(
    path: Path, ffmpeg: str, formats: str, at_ms: int, w: int, h: int
) -> np.ndarray | None:
    argv = [
        ffmpeg,
        "-nostdin",
        "-v",
        "error",
        "-ss",
        f"{at_ms / 1000:.3f}",
        *_tool.media_input_args(path, formats),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        f"scale={w}:{h}:flags=area",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(argv, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise _tool.ToolError("TOOL_MISSING", f"{ffmpeg} not found") from exc
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.decode("utf-8", "replace").strip().splitlines()[-10:])
        raise _tool.ToolError("MEDIA_UNREADABLE", f"ffmpeg frame decode failed: {tail}")
    if len(proc.stdout) < w * h * 3:
        return None  # past the end
    return np.frombuffer(proc.stdout[: w * h * 3], dtype=np.uint8).reshape(h * w, 3)


def kmeans(pixels: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Centres (k × 3, float) and the pixel count per centre. k-means++ start, fixed seed."""
    rng = np.random.default_rng(SEED)
    data = pixels.astype(np.float64)
    uniq = np.unique(pixels, axis=0)
    k = min(k, len(uniq))
    centres = [data[rng.integers(len(data))]]
    for _ in range(1, k):
        d = np.min(((data[:, None, :] - np.array(centres)[None]) ** 2).sum(-1), axis=1)
        if d.sum() == 0:
            break
        centres.append(data[rng.choice(len(data), p=d / d.sum())])
    c = np.array(centres)
    labels = np.zeros(len(data), dtype=np.int64)
    for _ in range(ITERATIONS):
        labels = ((data[:, None, :] - c[None]) ** 2).sum(-1).argmin(axis=1)
        moved = np.array(
            [data[labels == j].mean(axis=0) if np.any(labels == j) else c[j] for j in range(len(c))]
        )
        if np.allclose(moved, c, atol=0.01):
            c = moved
            break
        c = moved
    counts = np.bincount(labels, minlength=len(c))
    return c, counts


def describe(centre: np.ndarray, count: int, total: int) -> dict:
    r, g, b = (round(float(v)) for v in np.clip(centre, 0, 255))
    _, light, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    return {
        "hex": f"#{r:02X}{g:02X}{b:02X}",
        "rgb": [r, g, b],
        "share": round(count / total, 4),
        "lightness": round(light, 4),
        "saturation": round(sat, 4),
    }


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
    k = _tool.int_at_least(req, "k", 8, 2, 16)
    short_side = _tool.int_at_least(req, "shortSide", 64, 16, 256)

    width, height, _ = probe(path, ffprobe, formats)
    w, h = scaled_size(width, height, short_side)
    chunks = []
    for i, t in enumerate(at):
        px = frame_at(path, ffmpeg, formats, t, w, h)
        if px is not None:
            chunks.append(px)
        _tool.progress((i + 1) / len(at), f"keyframe {i + 1} of {len(at)}")
    if not chunks:
        raise _tool.ToolError("MEDIA_UNREADABLE", "no keyframe could be read")
    pixels = np.concatenate(chunks)
    centres, counts = kmeans(pixels, k)
    total = int(counts.sum())
    colors = [
        describe(centres[j], int(counts[j]), total)
        for j in np.argsort(-counts, kind="stable")
        if counts[j] > 0
    ]
    return {"colors": colors, "frames": len(chunks), "k": k}


if __name__ == "__main__":
    _tool.main(handle)
