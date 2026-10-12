"""Font crop strip for the GATE 8 A/B sheet (phase 15, round 3).

    uv run --project py python -I scripts/font-strip.py --video <ref.mp4> --ms 9000,3400 \
        --tier1 <font.ttf>[:trackingEm[:stretch]] --tier2 <font.ttf>[:trackingEm[:stretch]] --out <strip.jpg>

For each caption line Apple Vision OCR finds at the given times (lines centred horizontally), the
strip shows one row: the reference crop, its binarized text mask (the mask fontmatch scores), and
the same text rendered in the chosen font at the same ink height. Upper-case lines use the tier 2
font, the others the tier 1 font. The strip holds frames of the reference, so keep it out of git.
"""

from __future__ import annotations

import argparse
import io
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "py"))

from vox_py.fontmatch import Candidate, ink_bbox, line_pixels, text_mask  # noqa: E402
from vox_py.ocr import recognise  # noqa: E402

ROW_H = 72
GAP = 12


def frame_at(video: str, ms: int) -> np.ndarray:
    png = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{ms / 1000:.3f}", "-i", video, "-frames:v", "1",
         "-f", "image2pipe", "-vcodec", "png", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))


def font_arg(raw: str) -> tuple[Candidate, float, float]:
    parts = raw.split(":")
    track = float(parts[1]) if len(parts) > 1 else 0.0
    stretch = float(parts[2]) if len(parts) > 2 else 1.0
    return Candidate(Path(parts[0]).stem, Path(parts[0]), None), track, stretch


def fit_h(img: Image.Image, h: int, stretch: float = 1.0) -> Image.Image:
    w = max(1, round(img.width * h / max(1, img.height) * stretch))
    return img.resize((w, h), Image.LANCZOS)


def mask_img(mask: np.ndarray) -> Image.Image:
    return Image.fromarray(np.where(mask, 255, 0).astype(np.uint8)).convert("RGB")


def row_for(frame: np.ndarray, line: dict, fonts: dict) -> Image.Image | None:
    text = line["text"].strip()
    box = dict(line["box"])
    # wide margins left and right, thin ones above and below (the other tier sits right there)
    px, py = box["h"] * 0.25, box["h"] * 0.05
    box.update(x=box["x"] - px, y=box["y"] - py, w=box["w"] + 2 * px, h=box["h"] + 2 * py)
    crop, _ = line_pixels(frame, box)
    tm = text_mask(crop)
    if tm is None:
        return None
    mask = tm[0]
    bb = ink_bbox(mask)
    if bb is None:
        return None
    x0, y0, x1, y1 = bb
    tier = 2 if any(c.isalpha() for c in text) and text.upper() == text else 1
    cand, track, stretch = fonts[tier]
    rend = cand.render(text, track)
    rb = ink_bbox(rend)
    if rb is None:
        return None
    ref_crop = Image.fromarray(crop[y0:y1, x0:x1].astype(np.uint8))
    ref_mask = mask_img(mask[y0:y1, x0:x1])
    render = mask_img(rend[rb[1] : rb[3], rb[0] : rb[2]])
    # the same ink height as the reference; the stretch is the preset's horizontal scale
    tiles = [fit_h(ref_crop, ROW_H), fit_h(ref_mask, ROW_H), fit_h(render, ROW_H, stretch)]
    label = f"tier {tier}: {cand.id}"
    w = sum(t.width for t in tiles) + GAP * (len(tiles) + 1)
    out = Image.new("RGB", (max(w, 360), ROW_H + 26), (40, 40, 40))
    x = GAP
    for t in tiles:
        out.paste(t, (x, 20))
        x += t.width + GAP
    ImageDraw.Draw(out).text((GAP, 4), f"{text!r}  reference | mask | {label}", fill=(230, 230, 230))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--ms", required=True)
    ap.add_argument("--tier1", required=True)
    ap.add_argument("--tier2", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    fonts = {1: font_arg(a.tier1), 2: font_arg(a.tier2)}
    rows = []
    for ms in [int(x) for x in a.ms.split(",")]:
        frame = frame_at(a.video, ms)
        for line in recognise(frame):
            cx = line["box"]["x"] + line["box"]["w"] / 2
            if 0.2 <= cx <= 0.8 and line["box"]["y"] > 0.1:
                r = row_for(frame, line, fonts)
                if r is not None:
                    rows.append(r)
    if not rows:
        sys.exit("no caption lines found")
    w = max(r.width for r in rows)
    sheet = Image.new("RGB", (w, sum(r.height for r in rows)), (40, 40, 40))
    y = 0
    for r in rows:
        sheet.paste(r, (0, y))
        y += r.height
    sheet.save(a.out, quality=90)
    print(f"{len(rows)} rows -> {a.out}")


if __name__ == "__main__":
    main()
