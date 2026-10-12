"""Measured caption font match and caption look of a reference video (styles spec Part C, plan phase 15,
GATE 8 round 3).

Run as `python -I -m vox_py.fontmatch`. Request: `{ videoPath, samples, fonts, ffmpeg?, ffprobe?,
formatWhitelist?, shortSide?, normHeight? }`:
- `samples`: `{ atMs, lines: [{ text, box }] }[]`, the caption lines Apple Vision OCR read on a few
  frames (boxes normalised, top-left origin, as `vox_py.ocr` gives them);
- `fonts`: `{ id, path, weights? }[]`, the candidate font files (a variable file is tried at each
  weight in `weights`).

For every line: ffmpeg decodes the frame (short side `shortSide`, default 720), the line box is cropped,
and the text pixels are separated from the background (Otsu threshold; the text is the smaller class).
The ink is cropped to its bounding box and scaled to `normHeight` pixels (default 48). Each candidate
font renders the same text at the same ink height, with the letter spacing that gives the same ink
width; the score is the intersection over union of the two glyph masks (best of a few pixels of
horizontal shift). Deterministic: no randomness, fixed shifts.

The line's look is measured from the same crop: a flat box behind the text (fill colour, padding,
outline, text knocked out to the footage), an RGB fringe (the red and blue channel edges shifted
apart), and a soft glow around the text.

Lines are grouped in tiers by letter case: tier 1 = mixed or lower case, tier 2 = upper case. Result
(`py/tests/schemas/fontmatch.result.json`): `lines` (per line: tier, size, look, best fonts) and
`tiers` (per tier: the candidates ranked by their mean score over the tier's lines, plus the median
look), and `twoTier` (frames with a tier 1 line directly above a tier 2 line).
"""

from __future__ import annotations

import re
import statistics
from pathlib import Path

import numpy as np

from . import _tool
from .facetrack import probe, scaled_size
from .palette import frame_at

REQUEST: _tool.Spec = {
    "videoPath": (str, True),
    "samples": (list, True),
    "fonts": (list, True),
    "ffmpeg": (str, False),
    "ffprobe": (str, False),
    "formatWhitelist": (str, False),
    "shortSide": (int, False),
    "normHeight": (int, False),
    "occlusion": (list, False),
}

MAX_SAMPLES = 24
MAX_LINES = 40
MAX_FONTS = 200
RENDER_SIZE = 100
SHIFTS = range(-3, 4)
TRACKING_MIN, TRACKING_MAX = -0.08, 0.35
# horizontal stretches tried per candidate (CSS scaleX), each step after the first costs a little
STRETCHES = (1.0, 1.15, 1.3)
STRETCH_COST = 0.02
# weight of the outline-direction gap (pixel fonts vs curves) against the IoU
AXIS_WEIGHT = 0.5
# weight of the stroke-width gap (|ln| of the ratio): a bold face over thin strokes, or the reverse
STROKE_WEIGHT = 0.3
# slack on the reference's axis share when ruling out faces (`summarise_tier`)
AXIS_MARGIN = 0.02
# a red/blue edge offset at least this large (px) counts as a fringe
FRINGE_MIN_PX = 0.15
# ... or a red/cyan split at the text edges at least this large (0..255)
FRINGE_MIN_SPLIT = 12
# a usable line: enough contrast between text and background
MIN_SEPARATION = 50
# a usable line: at least this many letter-shaped components per letter of the OCR text (joined
# italic letters count as one)
MIN_GLYPH_SHARE = 0.4
TOP = 8
# occlusion: frames checked at most, the subject's share of a line box that can tell (outside it
# the box is all subject or all background), and the ink ratio (inside the subject vs outside) under
# which the text runs behind the subject
MAX_OCCLUSION = 60
OCCLUSION_COVER = (0.05, 0.9)
OCCLUSION_RATIO = 0.35
OCCLUSION_MIN_INK = 0.05


def _box(raw: object, what: str) -> dict:
    if not isinstance(raw, dict):
        raise _tool.ToolError("INVALID_REQUEST", f"{what} must be an object")
    out = {}
    for k in ("x", "y", "w", "h"):
        v = raw.get(k)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= 1:
            raise _tool.ToolError("INVALID_REQUEST", f"{what}.{k} must be a number in 0..1")
        out[k] = float(v)
    if out["w"] <= 0 or out["h"] <= 0:
        raise _tool.ToolError("INVALID_REQUEST", f"{what} must have a size")
    return out


def check_samples(raw: list) -> list[dict]:
    if not 1 <= len(raw) <= MAX_SAMPLES:
        raise _tool.ToolError("INVALID_REQUEST", f"samples must have 1..{MAX_SAMPLES} items")
    out = []
    n = 0
    for i, s in enumerate(raw):
        if not isinstance(s, dict) or not isinstance(s.get("lines"), list):
            raise _tool.ToolError("INVALID_REQUEST", f"samples[{i}] needs atMs and lines")
        at = s.get("atMs")
        if not isinstance(at, int) or isinstance(at, bool) or at < 0:
            raise _tool.ToolError("INVALID_REQUEST", f"samples[{i}].atMs must be an integer >= 0")
        lines = []
        for j, ln in enumerate(s["lines"]):
            what = f"samples[{i}].lines[{j}]"
            if not isinstance(ln, dict) or not isinstance(ln.get("text"), str):
                raise _tool.ToolError("INVALID_REQUEST", f"{what}.text must be a string")
            text = ln["text"].strip()[:120]
            if not text:
                raise _tool.ToolError("INVALID_REQUEST", f"{what}.text is empty")
            lines.append({"text": text, "box": _box(ln.get("box"), f"{what}.box")})
        n += len(lines)
        out.append({"atMs": at, "lines": lines})
    if n > MAX_LINES:
        raise _tool.ToolError("INVALID_REQUEST", f"samples hold more than {MAX_LINES} lines")
    return out


def check_occlusion(raw: list) -> list[dict]:
    if len(raw) > MAX_OCCLUSION:
        raise _tool.ToolError("INVALID_REQUEST", f"occlusion has more than {MAX_OCCLUSION} items")
    out = []
    for i, o in enumerate(raw):
        if not isinstance(o, dict) or not isinstance(o.get("boxes"), list) or not o["boxes"]:
            raise _tool.ToolError("INVALID_REQUEST", f"occlusion[{i}] needs atMs and boxes")
        at = o.get("atMs")
        if not isinstance(at, int) or isinstance(at, bool) or at < 0:
            raise _tool.ToolError("INVALID_REQUEST", f"occlusion[{i}].atMs must be an integer >= 0")
        boxes = [_box(b, f"occlusion[{i}].boxes[{j}]") for j, b in enumerate(o["boxes"][:4])]
        out.append({"atMs": at, "boxes": boxes})
    return out


def check_fonts(raw: list) -> list[dict]:
    if not 1 <= len(raw) <= MAX_FONTS:
        raise _tool.ToolError("INVALID_REQUEST", f"fonts must have 1..{MAX_FONTS} items")
    out = []
    for i, f in enumerate(raw):
        if not isinstance(f, dict) or not isinstance(f.get("id"), str) or not f["id"]:
            raise _tool.ToolError("INVALID_REQUEST", f"fonts[{i}].id must be a string")
        path = _tool.existing_file(f.get("path", "") if isinstance(f.get("path"), str) else "")
        if path.suffix.lower() not in (".ttf", ".otf"):
            raise _tool.ToolError("INVALID_REQUEST", f"fonts[{i}].path must be a .ttf or .otf file")
        weights = f.get("weights", [])
        if not isinstance(weights, list) or not all(
            isinstance(w, int) and not isinstance(w, bool) and 1 <= w <= 1000 for w in weights
        ):
            raise _tool.ToolError("INVALID_REQUEST", f"fonts[{i}].weights must be weights 1..1000")
        out.append({"id": f["id"], "path": path, "weights": weights[:6]})
    return out


# ---- image helpers (numpy only) ----


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def otsu(values: np.ndarray) -> float:
    """Otsu threshold of 0..255 values."""
    hist = np.bincount(np.clip(values.astype(np.int64), 0, 255).ravel(), minlength=256).astype(float)
    total = hist.sum()
    if total == 0:
        return 127.0
    levels = np.arange(256, dtype=float)
    w0 = np.cumsum(hist)
    m0 = np.cumsum(hist * levels)
    w1 = total - w0
    mean_all = m0[-1] / total
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mean_all * w0 - m0) ** 2 / (w0 * w1)
    between[~np.isfinite(between)] = 0
    return float(np.argmax(between))


def resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    """Area-ish resize of a float image (PIL bilinear on a float image)."""
    from PIL import Image

    im = Image.fromarray(img.astype(np.float32), mode="F")
    return np.asarray(im.resize((max(1, w), max(1, h)), Image.Resampling.BILINEAR), dtype=float)


def ink_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    """(x0, y0, x1, y1) of the ink: rows and columns with at least 5 % of the fullest one's ink."""
    rows = mask.sum(axis=1)
    cols = mask.sum(axis=0)
    if rows.max(initial=0) <= 0:
        return None
    ry = np.nonzero(rows >= 0.05 * rows.max())[0]
    cx = np.nonzero(cols >= 0.05 * cols.max())[0]
    return int(cx[0]), int(ry[0]), int(cx[-1]) + 1, int(ry[-1]) + 1


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            out |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return out


def axis_share(mask: np.ndarray) -> float:
    """Share of the glyph outline's gradient that runs along the pixel axes (within 15 degrees of
    horizontal or vertical): near 1 for pixel and bitmap fonts, lower for curves and diagonals."""
    m = mask.astype(float)
    # a light blur so a straight edge has one direction and a staircase keeps its steps
    k = np.array([1.0, 2.0, 1.0]) / 4
    m = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 1, m)
    m = np.apply_along_axis(lambda c: np.convolve(c, k, mode="same"), 0, m)
    gy, gx = np.gradient(m)
    mag = np.hypot(gx, gy)
    if mag.sum() <= 0:
        return 0.0
    ang = np.degrees(np.arctan2(np.abs(gy), np.abs(gx)))  # 0..90
    axis = (ang <= 15) | (ang >= 75)
    return float(mag[axis].sum() / mag.sum())


def soft_axis(img: np.ndarray) -> float:
    """Share of the strong gradients of a grey image (not thresholded) that run within 10 degrees of
    the pixel axes. Read at the reference's own resolution: pixel fonts keep their stair steps there,
    while blur (video coding) can only lower the share of a crisp face."""
    gy, gx = np.gradient(img.astype(float))
    mag = np.hypot(gx, gy)
    if mag.max(initial=0) <= 0:
        return 0.0
    strong = mag > 0.25 * mag.max()
    ang = np.degrees(np.arctan2(np.abs(gy), np.abs(gx)))
    return float(mag[strong & ((ang <= 10) | (ang >= 80))].sum() / mag[strong].sum())


def native_axis(mask: np.ndarray, native_h: int) -> float:
    """`soft_axis` of a crisp render, box-filtered down to the reference's ink height."""
    from PIL import Image

    bb = ink_bbox(mask)
    if bb is None:
        return 0.0
    part = mask[bb[1] : bb[3], bb[0] : bb[2]].astype(np.float32) * 255
    w = max(1, round(part.shape[1] * native_h / part.shape[0]))
    small = Image.fromarray(part, mode="F").resize((w, native_h), Image.Resampling.BOX)
    return soft_axis(np.asarray(small, dtype=float))


def stroke_width(mask: np.ndarray) -> float:
    """Mean stroke width in pixels: twice the ink area over its outline length."""
    m = mask.astype(bool)
    area = float(m.sum())
    edge = float((m[:, 1:] != m[:, :-1]).sum() + (m[1:, :] != m[:-1, :]).sum())
    return 2 * area / edge if edge else 0.0


def shape_f1(a: np.ndarray, b: np.ndarray, tol: int = 2) -> float:
    """Best F1 of the two masks' pixels lying within `tol` px of the other mask, b shifted by a few
    pixels: forgiving to a pixel of misplacement, strict about strokes where the other has none."""
    pad = max(SHIFTS) + tol
    w = max(a.shape[1], b.shape[1]) + 2 * pad
    aa = np.zeros((a.shape[0] + 2 * tol, w), dtype=bool)
    aa[tol:-tol, pad : pad + a.shape[1]] = a
    da = dilate(aa, tol)
    na = float(aa.sum())
    best = 0.0
    for s in SHIFTS:
        bb = np.zeros_like(aa)
        bb[tol:-tol, pad + s : pad + s + b.shape[1]] = b
        nb = float(bb.sum())
        if not na or not nb:
            continue
        precision = float((bb & da).sum()) / nb
        recall = float((aa & dilate(bb, tol)).sum()) / na
        if precision + recall:
            best = max(best, 2 * precision * recall / (precision + recall))
    return best


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """Best IoU of two boolean masks of one height, b shifted by a few pixels; widths padded."""
    w = max(a.shape[1], b.shape[1]) + 2 * max(SHIFTS)
    pad = max(SHIFTS)
    aa = np.zeros((a.shape[0], w), dtype=bool)
    aa[:, pad : pad + a.shape[1]] = a
    best = 0.0
    for s in SHIFTS:
        bb = np.zeros((b.shape[0], w), dtype=bool)
        bb[:, pad + s : pad + s + b.shape[1]] = b
        union = np.logical_or(aa, bb).sum()
        if union:
            best = max(best, float(np.logical_and(aa, bb).sum() / union))
    return best


# ---- the reference line ----


def line_pixels(frame: np.ndarray, box: dict) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """The line crop (RGB float) and its pixel rectangle (x0, y0, x1, y1) in the frame."""
    h, w = frame.shape[:2]
    x0 = max(0, int(box["x"] * w))
    y0 = max(0, int(box["y"] * h))
    x1 = min(w, int(np.ceil((box["x"] + box["w"]) * w)))
    y1 = min(h, int(np.ceil((box["y"] + box["h"]) * h)))
    return frame[y0:y1, x0:x1].astype(float), (x0, y0, x1, y1)


def components(mask: np.ndarray) -> list[tuple[list[tuple[int, int]], tuple[int, int, int, int]]]:
    """4-connected components of a small boolean mask: (pixels, (x0, y0, x1, y1))."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if seen[y, x]:
            continue
        seen[y, x] = True
        stack = [(y, x)]
        px = []
        while stack:
            cy, cx = stack.pop()
            px.append((cy, cx))
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        pys = [p[0] for p in px]
        pxs = [p[1] for p in px]
        out.append((px, (min(pxs), min(pys), max(pxs) + 1, max(pys) + 1)))
    return out


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """Drops specks and the edges of a box the OCR rectangle cut into: long thin bars (a box's top or
    bottom edge anywhere, a side edge only where it touches the left or right of the crop)."""
    h, w = mask.shape
    out = np.zeros_like(mask, dtype=bool)
    for px, (x0, y0, x1, y1) in components(mask):
        bw, bh = x1 - x0, y1 - y0
        if len(px) < 4:
            continue
        if bh <= max(3, h * 0.08) and bw >= 0.3 * w:
            continue
        if bw >= 0.9 * w and (y0 == 0 or y1 == h):
            continue  # a box frame cut by the crop: no glyph spans the whole line
        if bw <= max(3, w * 0.02) and bh >= 0.7 * h and (x0 <= 0.03 * w or x1 >= 0.97 * w):
            continue
        rows, cols = zip(*px)
        out[list(rows), list(cols)] = True
    return out


def glyph_count(mask: np.ndarray) -> int:
    """Components shaped like letters: at least a quarter of the line high, under half of it wide."""
    h, w = mask.shape
    n = 0
    for px, (x0, y0, x1, y1) in components(mask):
        if len(px) >= 4 and y1 - y0 >= 0.25 * h and x1 - x0 <= 0.5 * w and y1 - y0 < h:
            n += 1
    return n


def text_mask(crop: np.ndarray) -> tuple[np.ndarray, float, bool] | None:
    """Text pixels of a line crop: (mask, separation of the two classes, text is the lighter class).
    The text is the class with more letter-shaped components; on a tie, the class that covers less
    of the crop's border (the background surrounds the glyphs), then the smaller class."""
    lum = luma(crop)
    if lum.size < 50 or min(lum.shape) < 4:
        return None
    t = otsu(lum)
    light = lum > t
    n_light = int(light.sum())
    if n_light == 0 or n_light == lum.size:
        return None
    sep = float(lum[light].mean() - lum[~light].mean())
    glyphs_light, glyphs_dark = glyph_count(light), glyph_count(~light)
    if glyphs_light != glyphs_dark:
        text_light = glyphs_light > glyphs_dark
    else:
        border = np.concatenate([light[0], light[-1], light[1:-1, 0], light[1:-1, -1]])
        light_border = float(border.mean())
        if abs(light_border - 0.5) < 0.1:
            text_light = n_light <= lum.size - n_light
        else:
            text_light = light_border < 0.5
    return clean_mask(light if text_light else ~light), sep, text_light


def hexof(rgb: np.ndarray) -> str:
    r, g, b = (int(round(min(255, max(0, v)))) for v in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"


def fringe_px(region: np.ndarray) -> float:
    """Horizontal offset (px, sub-pixel) between the red and blue channel edges, from the peak of
    their correlation (parabola through the best shift and its neighbours); 0 when they line up.
    Video chroma subsampling smears a fringe of a pixel or two, so it often reads below 1 px."""
    if region.shape[1] < 12 or region.shape[0] < 2:
        return 0.0
    gr = np.diff(region[..., 0], axis=1)
    gb = np.diff(region[..., 2], axis=1)

    def corr(s: int) -> float:
        a = gr[:, 4 + s : gr.shape[1] - 4 + s]
        b = gb[:, 4 : gb.shape[1] - 4]
        a = a - a.mean()
        b = b - b.mean()
        d = float(np.sqrt((a * a).sum() * (b * b).sum()))
        return float((a * b).sum() / d) if d else 0.0

    scores = {s: corr(s) for s in range(-4, 5)}
    best = max(scores, key=lambda s: (scores[s], -abs(s)))
    if abs(best) == 4:
        return float(abs(best))
    lo, mid, hi = scores[best - 1], scores[best], scores[best + 1]
    den = lo - 2 * mid + hi
    off = best + (0.5 * (lo - hi) / den if den < 0 else 0.0)
    return round(abs(off), 2)


def fringe_split(region: np.ndarray) -> float:
    """Red/cyan split at the text's vertical edges (0..255): the mean red-minus-blue on edges going
    light to dark (left to right) minus the same on edges going dark to light. A chromatic fringe
    (red on one side of each stroke, cyan on the other) gives a large split even when chroma
    subsampling smears its offset below a pixel; the footage's own colour cast cancels out."""
    if region.shape[1] < 6 or region.shape[0] < 3:
        return 0.0
    lum = luma(region)
    g = np.diff(lum, axis=1)
    chroma = region[..., 0] - region[..., 2]
    c = (chroma[:, 1:] + chroma[:, :-1]) / 2
    down, up = g < -30, g > 30
    if down.sum() < 10 or up.sum() < 10:
        return 0.0
    return round(abs(float(c[down].mean() - c[up].mean())), 1)


def box_look(frame: np.ndarray, rect: tuple[int, int, int, int], mask: np.ndarray, size: float):
    """A flat box behind the text: fill, padding (em), outline, knockout; None when there is none."""
    x0, y0, x1, y1 = rect
    crop = frame[y0:y1, x0:x1].astype(float)
    bg = crop[~mask]
    if bg.shape[0] < 20:
        return None
    if float(luma(bg).std()) > 22:
        return None  # the background varies: footage, not a box
    fill = np.median(bg, axis=0)

    def near(px: np.ndarray) -> np.ndarray:
        return np.abs(px.astype(float) - fill).max(axis=-1) <= 40

    h, w = frame.shape[:2]
    bb = ink_bbox(mask)
    if bb is None:
        return None
    ix0, iy0, ix1, iy1 = bb[0] + x0, bb[1] + y0, bb[2] + x0, bb[3] + y0
    mid_y = slice(iy0, iy1)
    mid_x = slice(ix0, ix1)
    reach = int(size * 2)

    def walk(get, limit: int) -> int:
        n = 0
        for i in range(1, limit):
            px = get(i)
            if px is None or px.size == 0 or near(px).mean() < 0.7:
                break
            n = i
        return n

    left = walk(lambda i: frame[mid_y, ix0 - i] if ix0 - i >= 0 else None, reach)
    right = walk(lambda i: frame[mid_y, ix1 - 1 + i] if ix1 - 1 + i < w else None, reach)
    top = walk(lambda i: frame[iy0 - i, mid_x] if iy0 - i >= 0 else None, reach)
    bottom = walk(lambda i: frame[iy1 - 1 + i, mid_x] if iy1 - 1 + i < h else None, reach)
    bx0, bx1, by0, by1 = ix0 - left, ix1 + right, iy0 - top, iy1 + bottom
    # the edge one pixel outside the walk: an outline is lighter than the fill
    edge = []
    if by0 - 1 >= 0:
        edge.append(frame[by0 - 1, bx0:bx1])
    if by1 < h:
        edge.append(frame[by1, bx0:bx1])
    edge_l = float(luma(np.concatenate(edge).astype(float)).mean()) if edge else 0.0
    fill_l = float(luma(fill[None, :])[0])
    outline = bool(edge and (edge_l - fill_l >= 8 or (edge_l >= 225 and fill_l < 235)))
    if edge and not outline:
        edge_rgb = np.median(np.concatenate(edge).astype(float), axis=0)
        beyond = []
        if by0 - 3 >= 0:
            beyond.append(frame[by0 - 3, bx0:bx1])
        if by1 + 2 < h:
            beyond.append(frame[by1 + 2, bx0:bx1])
        far = np.median(np.concatenate(beyond).astype(float), axis=0) if beyond else fill
        outline = bool(
            np.abs(edge_rgb - fill).max() >= 20
            and np.abs(edge_rgb - far).max() >= 20
            and fill_l - edge_l < 60
        )
    # an inner rule: a dark line just outside the walk with the fill again a few pixels further out
    # (a frame line drawn inside the box edge)
    rule = False
    if edge and fill_l - edge_l >= 60:
        for gap in range(2, 6):
            outer = []
            if by0 - gap >= 0:
                outer.append(frame[by0 - gap, bx0:bx1])
            if by1 - 1 + gap < h:
                outer.append(frame[by1 - 1 + gap, bx0:bx1])
            if outer and near(np.concatenate(outer)).mean() >= 0.7:
                rule = True
                break
    # knockout: the text shows the footage around the box (its colour is close to the ring outside)
    ring = []
    pad = max(2, int(size * 0.3))
    for ys, xs in (
        (slice(max(0, by0 - 2 * pad), max(0, by0 - pad)), slice(bx0, bx1)),
        (slice(min(h, by1 + pad), min(h, by1 + 2 * pad)), slice(bx0, bx1)),
    ):
        part = frame[ys, xs]
        if part.size:
            ring.append(part.reshape(-1, 3).astype(float))
    text_px = crop[mask]
    knockout = False
    if ring and text_px.shape[0]:
        outside = np.median(np.concatenate(ring), axis=0)
        inside = np.median(text_px, axis=0)
        knockout = bool(
            np.abs(outside - inside).max() < 60 and np.abs(inside - fill).max() > 60
        )
    return {
        "fill": hexof(fill),
        "fillLightness": round(fill_l / 255, 3),
        "padXEm": round((left + right) / 2 / size, 3),
        "padYEm": round((top + bottom) / 2 / size, 3),
        "outline": outline,
        "rule": rule,
        "knockout": knockout,
        "rect": (bx0, by0, bx1, by1),
    }


def glow(frame: np.ndarray, rect: tuple[int, int, int, int], mask: np.ndarray) -> bool:
    """Light text with a soft halo: the ring right around the glyphs is lighter than one further out."""
    x0, y0, x1, y1 = rect
    lum = luma(frame[y0:y1, x0:x1].astype(float))
    near_ring = dilate(mask, 2) & ~mask
    far_ring = dilate(mask, 6) & ~dilate(mask, 4)
    if near_ring.sum() < 10 or far_ring.sum() < 10:
        return False
    return float(lum[near_ring].mean() - lum[far_ring].mean()) > 12


# ---- candidate rendering ----


class Candidate:
    def __init__(self, font_id: str, path: Path, weight: int | None):
        from PIL import ImageFont

        self.id = font_id
        self.weight = weight
        self.font = ImageFont.truetype(str(path), RENDER_SIZE)
        if weight is not None:
            try:
                axes = self.font.get_variation_axes()
            except (OSError, AttributeError):
                axes = []
            if axes:
                values = []
                for a in axes:
                    tag = a.get("name", b"")
                    name = tag.decode() if isinstance(tag, bytes) else str(tag)
                    lo, hi = a.get("minimum", 0), a.get("maximum", 0)
                    want = weight if name.lower() in ("weight", "wght") else a.get("default", lo)
                    values.append(min(max(want, lo), hi))
                self.font.set_variation_by_axes(values)

    def render(self, text: str, tracking_em: float) -> np.ndarray:
        """Boolean ink mask of `text` (one line, letter by letter with `tracking_em` added)."""
        from PIL import Image, ImageDraw

        track = tracking_em * RENDER_SIZE
        adv = [self.font.getlength(c) for c in text]
        width = int(sum(adv) + max(0.0, track) * len(text) + RENDER_SIZE * 2)
        img = Image.new("L", (max(8, width), RENDER_SIZE * 2), 0)
        d = ImageDraw.Draw(img)
        x = RENDER_SIZE * 0.5
        for c, a in zip(text, adv):
            d.text((x, RENDER_SIZE * 0.4), c, font=self.font, fill=255)
            x += a + track
        return np.asarray(img, dtype=np.uint8) > 127


def norm_mask(mask_or_soft: np.ndarray, height: int) -> np.ndarray | None:
    """Crop to the ink and scale to `height` px (width keeps the aspect); boolean."""
    bb = ink_bbox(mask_or_soft > 0.5)
    if bb is None:
        return None
    x0, y0, x1, y1 = bb
    part = mask_or_soft[y0:y1, x0:x1].astype(float)
    w = max(1, round(part.shape[1] * height / part.shape[0]))
    return resize(part, w, height) > 0.5


def at_reference_scale(mask: np.ndarray, native_h: int, height: int, stretch: float) -> np.ndarray | None:
    """A rendered mask taken through the reference's pixels: cropped to its ink, scaled to the
    reference's native ink height (and stretched horizontally), then up to `height` like the
    reference line, so both carry the same resampling."""
    bb = ink_bbox(mask)
    if bb is None:
        return None
    x0, y0, x1, y1 = bb
    part = mask[y0:y1, x0:x1].astype(float)
    nw = max(1, round(part.shape[1] * native_h / part.shape[0] * stretch))
    small = resize(part, nw, native_h)
    w = max(1, round(nw * height / native_h))
    return resize(small, w, height) > 0.5


def score_line(
    ref: np.ndarray, native_h: int, text: str, cands: list[Candidate], height: int
) -> list[dict]:
    """Every candidate's score on this line: glyph-mask IoU minus the gap in outline direction
    (`axis_share`) and a small cost per stretch step; with its letter spacing (em), horizontal
    stretch and ink-to-size ratio."""
    out = []
    gaps = max(1, len(text) - 1)
    ref_axis = axis_share(ref)
    ref_stroke = stroke_width(ref)
    for c in cands:
        base = c.render(text, 0.0)
        bb = ink_bbox(base)
        if bb is None:
            continue
        bw, bh = bb[2] - bb[0], bb[3] - bb[1]
        k = height / bh  # render px → normalised px
        axis_native = native_axis(base, native_h)
        mean_adv = sum(c.font.getlength(ch) for ch in text) / max(1, len(text)) / RENDER_SIZE
        best: dict | None = None
        for step, stretch in enumerate(STRETCHES):
            want = ref.shape[1] / (k * stretch) - bw
            tracking = min(TRACKING_MAX, max(TRACKING_MIN, want / gaps / RENDER_SIZE))
            mask = c.render(text, tracking) if abs(tracking) > 0.002 else base
            m = at_reference_scale(mask, native_h, height, stretch)
            if m is None:
                continue
            shape = iou(ref, m)
            f1 = shape_f1(ref, m)
            axis_gap = abs(ref_axis - axis_share(m))
            sw = stroke_width(m)
            stroke_gap = abs(float(np.log(sw / ref_stroke))) if sw and ref_stroke else 1.0
            score = (
                f1 - AXIS_WEIGHT * axis_gap - STROKE_WEIGHT * stroke_gap - STRETCH_COST * step
            )
            if best is None or score > best["score"]:
                best = {
                    "font": c.id,
                    "weight": c.weight,
                    "score": round(score, 4),
                    "iou": round(shape, 4),
                    "f1": round(f1, 4),
                    "axisGap": round(axis_gap, 3),
                    "strokeGap": round(stroke_gap, 3),
                    "trackingEm": round(tracking, 3),
                    "stretch": stretch,
                    "axisNative": round(axis_native, 3),
                    "inkPerEm": bh / RENDER_SIZE,
                    # mean advance per character (em), spacing and stretch included
                    "advanceEm": round((mean_adv + tracking) * stretch, 4),
                }
        if best:
            out.append(best)
    return out


def case_of(text: str) -> str:
    letters = [c for c in text if c.isalpha()]
    if letters and all(c.isupper() for c in letters):
        return "upper"
    if letters and all(c.islower() for c in letters):
        return "lower"
    return "asis"


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("’", "'").replace("‘", "'")).strip()


def box_interior(crop: np.ndarray, mask: np.ndarray) -> tuple[int, int, int, int] | None:
    """(x0, y0, x1, y1) inside a flat box that fills most of the crop: the rows and columns where
    the background class is mostly the box fill, inset by a pixel. None without a flat box."""
    bg = ~mask
    lum = luma(crop)
    if bg.sum() < 20 or float(lum[bg].std()) > 22:
        return None
    rows = np.nonzero(bg.mean(axis=1) >= 0.5)[0]
    cols = np.nonzero(bg.mean(axis=0) >= 0.5)[0]
    if rows.size < 4 or cols.size < 4:
        return None
    x0, x1 = int(cols[0]) + 1, int(cols[-1])
    y0, y1 = int(rows[0]) + 1, int(rows[-1])
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    if (x0, y0, x1, y1) == (1, 1, crop.shape[1] - 1, crop.shape[0] - 1):
        return None
    return x0, y0, x1, y1


def measure_line(frame: np.ndarray, line: dict, cands: list[Candidate], height: int) -> dict | None:
    crop, rect = line_pixels(frame, line["box"])
    tm = text_mask(crop)
    if tm is None:
        return None
    mask, sep, text_light = tm
    if sep < MIN_SEPARATION:
        return None
    inner = box_interior(crop, mask)
    if inner is not None:
        # a flat box the OCR rectangle cuts into: read the text inside the box only
        ix0, iy0, ix1, iy1 = inner
        crop = crop[iy0:iy1, ix0:ix1]
        rect = (rect[0] + ix0, rect[1] + iy0, rect[0] + ix1, rect[1] + iy1)
        tm = text_mask(crop)
        if tm is None:
            return None
        mask, sep, text_light = tm
    text = clean_text(line["text"])
    letters = sum(1 for c in text if c.isalnum())
    if glyph_count(mask) < MIN_GLYPH_SHARE * letters:
        return None  # the crop does not hold the text (a cut or an animation between OCR and decode)
    bb = ink_bbox(mask)
    if bb is None or bb[3] - bb[1] < 6:
        return None
    ink = mask[bb[1] : bb[3], bb[0] : bb[2]]
    grey = luma(crop)[bb[1] : bb[3], bb[0] : bb[2]]
    ref_axis_native = soft_axis(grey if text_light else 255 - grey)
    ref = resize(ink.astype(float), max(1, round(ink.shape[1] * height / ink.shape[0])), height) > 0.5
    scores = score_line(ref, ink.shape[0], text, cands, height)
    if not scores:
        return None
    scores.sort(key=lambda s: (-s["score"], s["font"], s["weight"] or 0))
    best = scores[0]
    ink_px = bb[3] - bb[1]
    size = ink_px / best["inkPerEm"]  # font size (px) at the best font's proportions
    fh = frame.shape[0]
    box = box_look(frame, rect, mask, size)
    region_rect = box["rect"] if box else rect
    rx0, ry0, rx1, ry1 = region_rect
    pad = int(size * 0.3)
    region = frame[max(0, ry0 - pad) : ry1 + pad, max(0, rx0 - pad) : rx1 + pad].astype(float)
    look = {
        "textLight": text_light,
        "boxed": box is not None,
        "box": {k: v for k, v in box.items() if k != "rect"} if box else None,
        "fringePx": fringe_px(region),
        "fringeSplit": fringe_split(crop),
        "glow": glow(frame, rect, mask) if text_light and box is None else False,
    }
    return {
        "text": text,
        "case": case_of(text),
        "tier": 2 if case_of(text) == "upper" else 1,
        "yPct": round(100 * (line["box"]["y"] + line["box"]["h"] / 2), 2),
        "sizePct": round(100 * size / fh, 3),
        "inkHeightPx": ink_px,
        "separation": round(sep, 1),
        "axisNative": round(ref_axis_native, 3),
        "look": look,
        "scores": scores,
    }


def behind_subject(frame: np.ndarray, alpha: np.ndarray, box: dict) -> bool | None:
    """Whether a caption line runs behind the foreground subject: the subject (Apple Vision mask)
    covers part of the line box and holds far less of the text's ink than the rest of the box.
    None when the frame cannot tell (the box is all subject or all background, too little contrast,
    or the subject is as light or dark as the text)."""
    crop, (x0, y0, x1, y1) = line_pixels(frame, box)
    sub = alpha[y0:y1, x0:x1] > 127
    cover = float(sub.mean()) if sub.size else 0.0
    if not OCCLUSION_COVER[0] <= cover <= OCCLUSION_COVER[1]:
        return None
    tm = text_mask(crop)
    if tm is None or tm[1] < MIN_SEPARATION:
        return None
    text_light = tm[2]  # the text's tone over the whole line (letter-shaped components)
    lum = luma(crop)
    t = otsu(lum)
    ink = lum > t if text_light else lum <= t
    if sub.sum() < 50 or (~sub).sum() < 50 or ink.all() or not ink.any():
        return None
    text_level, bg_level = float(lum[ink].mean()), float(lum[~ink].mean())
    if abs(float(np.median(lum[sub])) - text_level) < abs(text_level - bg_level) / 2:
        return None  # the subject has the text's own tone: its ink cannot be told apart
    ink_out, ink_in = float(ink[~sub].mean()), float(ink[sub].mean())
    if ink_out < OCCLUSION_MIN_INK:
        return None
    return ink_in < OCCLUSION_RATIO * ink_out


def occlusion_of(path: Path, ffmpeg: str, formats: str, items: list[dict], w: int, h: int) -> dict:
    """Behind-subject captions over the `occlusion` frames (macOS 14+, Apple Vision subject mask)."""
    from .cutout import vision_alpha, vision_available

    if not items:
        return {"available": vision_available(), "frames": 0, "decided": 0, "behind": 0, "atMs": []}
    if not vision_available():
        return {"available": False, "frames": 0, "decided": 0, "behind": 0, "atMs": []}
    frames = decided = 0
    behind: list[int] = []
    for i, o in enumerate(items):
        _tool.progress(min(0.99, (i + 1) / len(items)), f"caption layers {i + 1} of {len(items)}")
        px = frame_at(path, ffmpeg, formats, o["atMs"], w, h)
        if px is None:
            continue
        frame = px.reshape(h, w, 3)
        alpha = vision_alpha(frame)
        frames += 1
        if alpha is None:
            continue
        votes = [behind_subject(frame, alpha, b) for b in o["boxes"]]
        if any(v is not None for v in votes):
            decided += 1
        if any(v is True for v in votes):
            behind.append(o["atMs"])
    return {"available": True, "frames": frames, "decided": decided, "behind": len(behind), "atMs": behind}


def summarise_tier(tier: int, lines: list[dict], frame_h: int) -> dict:
    fonts: dict[tuple[str, int | None], list[dict]] = {}
    for ln in lines:
        for s in ln["scores"]:
            fonts.setdefault((s["font"], s["weight"]), []).append(s)
    ranking = []
    for (font, weight), ss in fonts.items():
        if len(ss) < len(lines):
            continue
        ranking.append(
            {
                "font": font,
                "weight": weight,
                "score": round(statistics.fmean(s["score"] for s in ss), 4),
                "iou": round(statistics.fmean(s["iou"] for s in ss), 4),
                "trackingEm": round(statistics.median(s["trackingEm"] for s in ss), 3),
                "stretch": statistics.median(s["stretch"] for s in ss),
                "advanceEm": round(statistics.median(s["advanceEm"] for s in ss), 4),
                "axisNative": round(statistics.fmean(s["axisNative"] for s in ss), 3),
                "sizePct": round(
                    statistics.median(
                        100 * ln["inkHeightPx"] / s["inkPerEm"] / frame_h
                        for ln, s in zip(lines, ss)
                    ),
                    3,
                ),
            }
        )
    ranking.sort(key=lambda r: (-r["score"], r["font"], r["weight"] or 0))
    # Blur only lowers a crisp face's axis share, so a face whose crisp share is below the
    # reference's cannot be the reference's face (it has curves or diagonals where the reference has
    # pixel steps). The pick is the best-scoring face that passes.
    ref_axis = statistics.median(ln["axisNative"] for ln in lines)
    for r in ranking:
        r["eligible"] = r["axisNative"] >= ref_axis - AXIS_MARGIN
    eligible = [r for r in ranking if r["eligible"]]
    pick = eligible[0] if eligible else (ranking[0] if ranking else None)
    shown = ranking[:TOP] + [r for r in eligible[:3] if r not in ranking[:TOP]]
    boxed = [ln for ln in lines if ln["look"]["boxed"]]
    fills = [ln["look"]["box"]["fill"] for ln in boxed]
    return {
        "tier": tier,
        "lines": len(lines),
        "ranking": shown,
        "pick": pick,
        "refAxis": round(ref_axis, 3),
        "yPct": round(statistics.median(ln["yPct"] for ln in lines), 2),
        "boxedShare": round(len(boxed) / len(lines), 3),
        "box": (
            {
                # the per-channel median of the boxes' fills (one odd box does not decide)
                "fill": hexof(
                    np.median(
                        np.array([[int(f[i : i + 2], 16) for i in (1, 3, 5)] for f in fills], dtype=float),
                        axis=0,
                    )
                )
                if fills
                else None,
                "fillLightness": round(
                    statistics.median(ln["look"]["box"]["fillLightness"] for ln in boxed), 3
                ),
                "padXEm": round(statistics.median(ln["look"]["box"]["padXEm"] for ln in boxed), 3),
                "padYEm": round(statistics.median(ln["look"]["box"]["padYEm"] for ln in boxed), 3),
                "outlineShare": round(
                    sum(1 for ln in boxed if ln["look"]["box"]["outline"]) / len(boxed), 3
                ),
                "ruleShare": round(
                    sum(1 for ln in boxed if ln["look"]["box"]["rule"]) / len(boxed), 3
                ),
                "knockoutShare": round(
                    sum(1 for ln in boxed if ln["look"]["box"]["knockout"]) / len(boxed), 3
                ),
            }
            if boxed
            else None
        ),
        "textLightShare": round(sum(1 for ln in lines if ln["look"]["textLight"]) / len(lines), 3),
        "fringePx": round(statistics.median(ln["look"]["fringePx"] for ln in lines), 2),
        "fringeSplit": round(statistics.median(ln["look"]["fringeSplit"] for ln in lines), 1),
        "fringeShare": round(
            sum(
                1
                for ln in lines
                if ln["look"]["fringePx"] >= FRINGE_MIN_PX or ln["look"]["fringeSplit"] >= FRINGE_MIN_SPLIT
            )
            / len(lines),
            3,
        ),
        "glowShare": round(sum(1 for ln in lines if ln["look"]["glow"]) / len(lines), 3),
    }


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    path: Path = _tool.existing_file(req["videoPath"])
    samples = check_samples(req["samples"])
    fonts = check_fonts(req["fonts"])
    occlusion = check_occlusion(req.get("occlusion", []))
    ffmpeg = req.get("ffmpeg", "ffmpeg")
    ffprobe = req.get("ffprobe", "ffprobe")
    formats = req.get("formatWhitelist", _tool.DEFAULT_FORMAT_WHITELIST)
    short_side = _tool.int_at_least(req, "shortSide", 720, 160, 1080)
    height = _tool.int_at_least(req, "normHeight", 48, 16, 128)
    width, vh, _ = probe(path, ffprobe, formats)
    w, h = scaled_size(width, vh, short_side)

    cands: list[Candidate] = []
    for f in fonts:
        for weight in f["weights"] or [None]:
            try:
                cands.append(Candidate(f["id"], f["path"], weight))
            except OSError as exc:
                raise _tool.ToolError("INVALID_REQUEST", f"cannot read font {f['id']}: {exc}") from exc

    lines_out: list[dict] = []
    two_tier = 0
    frames_read = 0
    for i, s in enumerate(samples):
        px = frame_at(path, ffmpeg, formats, s["atMs"], w, h)
        _tool.progress(min(0.99, (i + 1) / len(samples)), f"caption fonts {i + 1} of {len(samples)}")
        if px is None:
            continue
        frames_read += 1
        frame = px.reshape(h, w, 3)
        got = []
        for ln in s["lines"]:
            m = measure_line(frame, ln, cands, height)
            if m:
                m["atMs"] = s["atMs"]
                m["box"] = ln["box"]
                got.append(m)
        # two tiers: a tier 1 line right above a tier 2 line (gap under 1.5 line heights)
        for a in got:
            for b in got:
                if a["tier"] == 1 and b["tier"] == 2:
                    gap = b["box"]["y"] - (a["box"]["y"] + a["box"]["h"])
                    if -0.25 * a["box"]["h"] <= gap <= 1.5 * a["box"]["h"]:
                        two_tier += 1
                        break
            else:
                continue
            break
        lines_out.extend(got)

    tiers = []
    for t in (1, 2):
        ls = [ln for ln in lines_out if ln["tier"] == t]
        if ls:
            tiers.append(summarise_tier(t, ls, h))
    for ln in lines_out:
        ln["best"] = [
            {k: s[k] for k in ("font", "weight", "score", "iou", "trackingEm", "stretch")} for s in ln["scores"][:5]
        ]
        del ln["scores"], ln["box"], ln["inkHeightPx"]
    return {
        "width": w,
        "height": h,
        "occlusion": occlusion_of(path, ffmpeg, formats, occlusion, w, h),
        "frames": frames_read,
        "candidates": len(cands),
        "lines": lines_out,
        "tiers": tiers,
        "twoTier": {
            "frames": two_tier,
            "share": round(two_tier / frames_read, 3) if frames_read else 0,
        },
    }


if __name__ == "__main__":
    _tool.main(handle)
