"""Pictures and text for the audio QA tool: `qa.png`, the kit sheet and `LISTEN.md`.

Homebrew ffmpeg has no `drawtext` (D-17), so the PNG is drawn with numpy and written with zlib (no
Pillow). A cue is labelled by a vertical marker plus its number (a 3x5 pixel font); `qa.json` maps
each number to its cue (plan D-22).
"""

from __future__ import annotations

import struct
import zlib

import numpy as np

from . import audioqa_dsp as dsp

WIDTH = 1600  # qa.png width in pixels
HEADER = 40  # marker label strip
ROW = 120  # one waveform row
AXIS = 16
MARKER_W = 2
MARKER_COLOR = (255, 64, 64)
HERO_COLOR = (255, 64, 255)
ONSET_COLOR = (0, 220, 100)
BACKGROUND = (24, 24, 28)
ROW_COLORS = {"sfx": (255, 170, 0), "speech": (80, 160, 255), "mix": (200, 200, 200)}

_FONT = {
    "0": "111101101101111", "1": "010110010010111", "2": "111001111100111",
    "3": "111001111001111", "4": "101101111001001", "5": "111100111001111",
    "6": "111100111101111", "7": "111001001001001", "8": "111101111101111",
    "9": "111101111001111",
}  # fmt: skip


def png_bytes(rgb: np.ndarray) -> bytes:
    """Encode an (h, w, 3) uint8 array as PNG."""
    h, w, _ = rgb.shape

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = np.concatenate([np.zeros((h, 1), np.uint8), rgb.reshape(h, w * 3)], axis=1)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw.tobytes(), 6))
        + chunk(b"IEND", b"")
    )


def draw_number(img: np.ndarray, value: int, x: int, y: int, scale: int = 3) -> None:
    color = (255, 255, 255)
    for k, ch in enumerate(str(value)):
        glyph = np.array([int(c) for c in _FONT[ch]], dtype=bool).reshape(5, 3)
        big = np.kron(glyph, np.ones((scale, scale), dtype=bool))
        x0 = x + k * 4 * scale
        h, w = big.shape
        if x0 + w > img.shape[1] or y + h > img.shape[0]:
            continue
        region = img[y : y + h, x0 : x0 + w]
        region[big] = color


def _waveform(img: np.ndarray, x: np.ndarray, y0: int, color: tuple[int, int, int]) -> None:
    """Draw min/max of mono samples per pixel column inside the row starting at y0."""
    mid, half = y0 + ROW // 2, ROW // 2 - 4
    n = len(x)
    img[mid, :, :] = (60, 60, 66)
    if n == 0:
        return
    bounds = np.linspace(0, n, WIDTH + 1).astype(int)
    starts = np.minimum(bounds[:-1], n - 1)
    lo = np.clip(np.minimum.reduceat(x, starts), -1, 1)
    hi = np.clip(np.maximum.reduceat(x, starts), -1, 1)
    for col in range(WIDTH):
        top = mid - round(hi[col] * half)
        bottom = mid - round(lo[col] * half)
        img[min(top, bottom, mid) : max(top, bottom, mid) + 1, col] = color


def render_qa_png(
    rows: list[tuple[str, np.ndarray]],
    duration_ms: float,
    cues: list[dict],
    onsets: list[dict],
) -> tuple[bytes, dict]:
    """Stem and mix waveforms with a numbered marker per cue.

    `rows` is `[(name, mono samples)]`. Returns the PNG and the layout recorded in `qa.json`.
    """
    height = HEADER + ROW * len(rows) + AXIS
    img = np.zeros((height, WIDTH, 3), dtype=np.uint8)
    img[:, :] = BACKGROUND
    layout_rows = []
    for k, (name, samples) in enumerate(rows):
        y0 = HEADER + k * ROW
        _waveform(img, samples, y0, ROW_COLORS.get(name, (200, 200, 200)))
        img[y0, :, :] = (70, 70, 78)
        layout_rows.append({"name": name, "y0": y0, "y1": y0 + ROW})
    for s in range(int(duration_ms // 1000) + 1):  # one tick per second on the axis
        x = min(WIDTH - 1, round(s * 1000 / duration_ms * (WIDTH - 1))) if duration_ms else 0
        img[height - AXIS : height - AXIS + 6, x] = (150, 150, 150)

    def x_of(ms: float) -> int:
        return min(WIDTH - MARKER_W, max(0, round(ms / duration_ms * (WIDTH - 1))))

    sfx_row = next((r for r in layout_rows if r["name"] == "sfx"), None)
    if sfx_row is not None:
        for o in onsets:
            img[sfx_row["y0"] + 1 : sfx_row["y0"] + 15, x_of(o["ms"])] = ONSET_COLOR
    markers = []
    for cue in cues:
        x = x_of(cue["atMs"])
        color = HERO_COLOR if cue["hero"] else MARKER_COLOR
        img[:, x : x + MARKER_W] = color
        markers.append({"cue": cue["index"], "x": x, "hero": cue["hero"]})
    for cue, m in zip(cues, markers):  # numbers last, staggered so neighbours do not overlap
        draw_number(img, cue["index"], m["x"] + 4, 3 + 18 * (cue["index"] % 2))
    layout = {
        "width": WIDTH,
        "height": height,
        "rows": layout_rows,
        "markerScanY": HEADER - 2,
        "markerWidthPx": MARKER_W,
        "markers": markers,
    }
    return png_bytes(img), layout


_PALETTE = np.array(
    [(0, 0, 0), (50, 0, 100), (190, 40, 90), (250, 160, 30), (255, 255, 210)], dtype=float
)


def render_kit_png(entries: list[tuple[np.ndarray, bool]], width: int = 1200) -> bytes:
    """One block per file: pass/fail strip, waveform and spectrogram (low frequencies at the bottom)."""
    wave_h, spec_h, strip = 80, 160, 6
    block = strip + wave_h + spec_h + 4
    img = np.zeros((block * len(entries), width, 3), dtype=np.uint8)
    img[:, :] = BACKGROUND
    for k, (samples, ok) in enumerate(entries):
        y0 = k * block
        img[y0 : y0 + strip, :] = (0, 170, 90) if ok else (220, 50, 50)
        mid = y0 + strip + wave_h // 2
        img[mid, :] = (60, 60, 66)
        n = len(samples)
        if n:
            bounds = np.linspace(0, n, width + 1).astype(int)
            starts = np.minimum(bounds[:-1], n - 1)
            lo = np.clip(np.minimum.reduceat(samples, starts), -1, 1)
            hi = np.clip(np.maximum.reduceat(samples, starts), -1, 1)
            for col in range(width):
                a = mid - round(hi[col] * (wave_h // 2 - 2))
                b = mid - round(lo[col] * (wave_h // 2 - 2))
                img[min(a, b, mid) : max(a, b, mid) + 1, col] = (255, 170, 0)
            spec = dsp.spectrogram_db(samples, width, spec_h)
            level = np.clip((spec + 90.0) / 90.0, 0.0, 1.0)[::-1]  # row 0 = highest frequency
            stops = np.linspace(0, 1, len(_PALETTE))
            colors = np.stack([np.interp(level, stops, _PALETTE[:, c]) for c in range(3)], axis=-1)
            img[y0 + strip + wave_h : y0 + strip + wave_h + spec_h] = colors.astype(np.uint8)
    return png_bytes(img)


def timecode(ms: float) -> str:
    total = round(ms)
    return f"{total // 60000:02d}:{total // 1000 % 60:02d}.{total % 1000:03d}"


def listen_markdown(items: list[dict], sequence_note: str) -> str:
    """LISTEN.md: up to five timecodes for a human ear check."""
    lines = [
        "# Listen check",
        "",
        sequence_note,
        "",
        "These timecodes come from measurements. The numbers in `qa.json` do not say the sound is",
        "good; only a person can judge that. Listen to each moment and mark it ok or not.",
        "",
    ]
    if not items:
        lines.append("No moments to listen to: no SFX hits were found.")
    for i, item in enumerate(items, 1):
        lines.append(f"{i}. `{timecode(item['atMs'])}` ({item['kind']}): {item['listenFor']}")
    return "\n".join(lines) + "\n"
