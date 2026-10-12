"""behind: captions composited behind the foreground subject (caption preset `behindSubject`,
phase 15 GATE 8 round 3). Two 1 s renders of a portrait, with and without a caption bar across the
face; Apple Vision gives the subject matte."""

import shutil
import subprocess

import numpy as np
import pytest
from conftest import REPO_ROOT, run_tool, stderr_error, validate
from test_cutout import needs_vision

from vox_py import behind

FACE = REPO_ROOT / "packages/engine/test/fixtures/assets/faces/face-a.jpg"
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def clip(png, out):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", str(png), "-t", "1", "-r", "10",
         "-vf", "scale=360:480,format=yuv420p", "-c:v", "libx264", "-crf", "10", str(out)],
        check=True,
    )
    return out


def renders(tmp_path):
    from PIL import Image, ImageDraw

    with Image.open(FACE) as im:
        face = im.convert("RGB").resize((360, 480))
    plain_png = tmp_path / "plain.png"
    face.save(plain_png)
    cap = face.copy()
    # a caption bar across the whole width at mid height: the face covers its middle
    ImageDraw.Draw(cap).rectangle((0, 220, 359, 260), fill=(255, 220, 0))
    cap_png = tmp_path / "cap.png"
    cap.save(cap_png)
    return clip(cap_png, tmp_path / "cap.mp4"), clip(plain_png, tmp_path / "plain.mp4")


def test_behind_checks_the_encoder_and_beats():
    assert behind.check_encoder({"codec": "libx264", "crf": 18})[:2] == ["-c:v", "libx264"]
    assert "h264_videotoolbox" in behind.check_encoder({"codec": "h264_videotoolbox", "bitrate": "5600k"})
    for bad in ({"codec": "x"}, {"codec": "libx264", "crf": 99}, {"codec": "h264_videotoolbox", "bitrate": "5M"}):
        with pytest.raises(Exception):
            behind.check_encoder(bad)
    assert behind.check_beats([{"startMs": 0, "endMs": 10}]) == [(0, 10)]
    with pytest.raises(Exception):
        behind.check_beats([{"startMs": 10, "endMs": 10}])


def test_behind_rejects_a_bad_request(tmp_path):
    f = tmp_path / "a.mp4"
    f.write_bytes(b"\0")
    req = {"captioned": str(f), "plain": str(f), "output": str(tmp_path / "o.mov"), "beats": [],
           "encoder": {"codec": "libx264"}}
    code, _, err = run_tool("behind", req)
    assert code == 1
    assert stderr_error(err)["code"] == "INVALID_REQUEST"


@needs_ffmpeg
@needs_vision
def test_behind_puts_the_face_over_the_caption_and_caches_mattes(tmp_path):
    cap, plain = renders(tmp_path)
    out = tmp_path / "out.mp4"
    req = {
        "captioned": str(cap),
        "plain": str(plain),
        "output": str(out),
        "beats": [{"startMs": 0, "endMs": 1000}],
        "mode": "auto",
        "encoder": {"codec": "libx264", "crf": 12},
        "cacheDir": str(tmp_path / "mattes"),
    }
    validate("behind.request.json", req)
    code, result, err = run_tool("behind", req, timeout=600)
    assert code == 0, err
    validate("behind.result.json", result)
    assert result["frames"] == 10
    assert result["beats"][0]["behind"] is True
    assert 0.08 <= result["beats"][0]["overlap"] <= 0.65
    assert result["composited"] == 10
    # the face is in front: the bar's yellow is gone at the centre, kept at the edges
    px = behind.frame_at("ffmpeg", out, 500, 360, 480, "bt601").astype(int)
    centre, edge = px[240, 180], px[240, 5]
    assert edge[2] < 80 and edge[0] > 200  # yellow
    assert not (centre[2] < 80 and centre[0] > 200 and centre[1] > 180)
    # again: every matte comes from the cache
    code, again, err = run_tool("behind", req, timeout=600)
    assert code == 0, err
    assert again["mattes"]["computed"] == 0 and again["mattes"]["cached"] > 0
    assert np.isclose(again["beats"][0]["overlap"], result["beats"][0]["overlap"])
