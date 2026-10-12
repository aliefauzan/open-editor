"""fontmatch: measured caption fonts and look per tier, and captions behind the subject (styles
Part C, phase 15 GATE 8 round 3). The frames are drawn here with catalogue fonts, so the right
answer is known."""

import shutil
import subprocess
import sys

import numpy as np
import pytest
from conftest import REPO_ROOT, run_tool, stderr_error, validate

from vox_py import fontmatch

FONTS = REPO_ROOT / "packages/engine/data/fonts"
SERIF_ITALIC = FONTS / "InstrumentSerif-Italic.ttf"
PIXEL = FONTS / "VT323-Regular.ttf"
SANS = FONTS / "Inter-Variable.ttf"
W, H = 720, 1280

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def two_tier_frame():
    """A dark textured frame with a white italic serif line over a boxed pixel-font line (dark
    letters on a near-white box), like the reference. Returns the image and the two line boxes."""
    from PIL import Image, ImageDraw, ImageFont

    rng = np.random.default_rng(7)
    bg = (rng.normal(40, 8, (H, W, 3))).clip(0, 255).astype(np.uint8)
    im = Image.fromarray(bg)
    d = ImageDraw.Draw(im)
    serif = ImageFont.truetype(str(SERIF_ITALIC), 64)
    pixel = ImageFont.truetype(str(PIXEL), 58)
    t1, t2 = "a literal story", "SUGAR FIELD"
    b1 = d.textbbox((0, 0), t1, font=serif)
    x1 = (W - (b1[2] - b1[0])) // 2
    d.text((x1 - b1[0], 560 - b1[1]), t1, font=serif, fill=(250, 250, 250))
    b2 = d.textbbox((0, 0), t2, font=pixel)
    x2 = (W - (b2[2] - b2[0])) // 2
    y2 = 660
    pad = 10
    d.rectangle(
        (x2 - pad, y2 - pad, x2 + b2[2] - b2[0] + pad, y2 + b2[3] - b2[1] + pad), fill=(253, 251, 250)
    )
    d.text((x2 - b2[0], y2 - b2[1]), t2, font=pixel, fill=(30, 40, 170))

    def box(x, y, w, h, m=6):
        return {"x": (x - m) / W, "y": (y - m) / H, "w": (w + 2 * m) / W, "h": (h + 2 * m) / H}

    lines = [
        {"text": t1, "box": box(x1, 560, b1[2] - b1[0], b1[3] - b1[1])},
        {"text": t2, "box": box(x2, y2, b2[2] - b2[0], b2[3] - b2[1], m=pad)},
    ]
    return im, lines


def video_of(im, path):
    png = path.with_suffix(".png")
    im.save(png)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", str(png), "-t", "1", "-r", "10",
         "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "12", str(path)],
        check=True,
    )
    return path


@needs_ffmpeg
def test_fontmatch_picks_the_drawn_faces_per_tier(tmp_path):
    im, lines = two_tier_frame()
    video = video_of(im, tmp_path / "two.mp4")
    req = {
        "videoPath": str(video),
        "samples": [{"atMs": 500, "lines": lines}],
        "fonts": [
            {"id": "InstrumentSerif-Italic.ttf", "path": str(SERIF_ITALIC)},
            {"id": "VT323-Regular.ttf", "path": str(PIXEL)},
            {"id": "Inter-Variable.ttf", "path": str(SANS), "weights": [400, 700]},
        ],
    }
    validate("fontmatch.request.json", req)
    code, result, err = run_tool("fontmatch", req, timeout=600)
    assert code == 0, err
    validate("fontmatch.result.json", result)
    tiers = {t["tier"]: t for t in result["tiers"]}
    assert tiers[1]["pick"]["font"] == "InstrumentSerif-Italic.ttf"
    assert tiers[2]["pick"]["font"] == "VT323-Regular.ttf"
    assert tiers[1]["pick"]["score"] > tiers[1]["ranking"][-1]["score"]
    # the box: near-white fill, the letters are blue, not the footage around the box (no cut-out)
    assert tiers[2]["boxedShare"] == 1.0
    assert tiers[2]["box"]["fillLightness"] > 0.95
    assert tiers[2]["box"]["knockoutShare"] == 0.0
    assert tiers[1]["textLightShare"] == 1.0
    assert result["twoTier"] == {"frames": 1, "share": 1.0}
    # deterministic
    code2, again, _ = run_tool("fontmatch", req, timeout=600)
    assert code2 == 0 and again == result


def test_fontmatch_rejects_bad_requests(tmp_path):
    video = tmp_path / "x.mp4"
    video.write_bytes(b"\0")
    font = {"id": "f", "path": str(PIXEL)}
    for bad in (
        {"videoPath": str(video), "samples": [], "fonts": [font]},
        {"videoPath": str(video), "samples": [{"atMs": 0, "lines": []}], "fonts": []},
        {
            "videoPath": str(video),
            "samples": [{"atMs": 0, "lines": [{"text": "x", "box": {"x": 2, "y": 0, "w": 1, "h": 1}}]}],
            "fonts": [font],
        },
        {
            "videoPath": str(video),
            "samples": [{"atMs": 0, "lines": []}],
            "fonts": [font],
            "occlusion": [{"atMs": -1, "boxes": []}],
        },
    ):
        code, _, err = run_tool("fontmatch", bad)
        assert code == 1
        assert stderr_error(err)["code"] == "INVALID_REQUEST"


def test_fringe_split_reads_a_red_cyan_edge_pair():
    region = np.full((20, 40, 3), 240.0)
    region[:, 15:25] = 30.0  # a dark stroke
    plain = fontmatch.fringe_split(region.copy())
    region[:, 14] = (240, 60, 60)  # red on the light-to-dark edge
    region[:, 25] = (60, 220, 240)  # cyan on the dark-to-light edge
    split = fontmatch.fringe_split(region)
    assert plain < 5
    assert split >= fontmatch.FRINGE_MIN_SPLIT * 3


def test_behind_subject_tells_text_behind_from_text_in_front():
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.truetype(str(SERIF_ITALIC), 60)
    frame = np.full((200, 600, 3), 90, dtype=np.uint8)
    alpha = np.zeros((200, 600), dtype=np.uint8)
    alpha[:, 300:] = 255
    frame[:, 300:] = 20  # a dark subject on the right half
    box = {"x": 50 / 600, "y": 60 / 200, "w": 500 / 600, "h": 80 / 200}

    behind = Image.fromarray(frame.copy())
    ImageDraw.Draw(behind).text((60, 70), "wide caption line", font=font, fill=(250, 250, 250))
    px = np.asarray(behind).copy()
    px[:, 300:] = 20  # the subject covers the caption
    assert fontmatch.behind_subject(px, alpha, box) is True

    front = Image.fromarray(frame.copy())
    ImageDraw.Draw(front).text((60, 70), "wide caption line", font=font, fill=(250, 250, 250))
    assert fontmatch.behind_subject(np.asarray(front), alpha, box) is False

    # all subject: the frame cannot tell
    assert fontmatch.behind_subject(np.asarray(front), np.full_like(alpha, 255), box) is None


def vision_ready() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Vision
    except ImportError:
        return False
    return hasattr(Vision, "VNGenerateForegroundInstanceMaskRequest")


@needs_ffmpeg
@pytest.mark.skipif(not vision_ready(), reason="needs Apple Vision (macOS 14+)")
def test_fontmatch_occlusion_runs_on_vision(tmp_path):
    im, lines = two_tier_frame()
    video = video_of(im, tmp_path / "two.mp4")
    req = {
        "videoPath": str(video),
        "samples": [{"atMs": 500, "lines": lines}],
        "fonts": [{"id": "VT323-Regular.ttf", "path": str(PIXEL)}],
        "occlusion": [{"atMs": 500, "boxes": [ln["box"] for ln in lines]}],
    }
    code, result, err = run_tool("fontmatch", req, timeout=600)
    assert code == 0, err
    occ = result["occlusion"]
    assert occ["available"] is True and occ["frames"] == 1
    # no subject runs over these captions
    assert occ["behind"] == 0 and occ["atMs"] == []
