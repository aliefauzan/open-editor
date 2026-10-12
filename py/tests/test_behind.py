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


# caption words at mid height (x spans); the face's matte spans about x 100-280 there
EDGE_WORDS = ((20, 130), (250, 350))  # the face covers the inner end of each word (about 30 %)
FACE_WORD = ((150, 230),)  # one word on the face


def renders(tmp_path, words=EDGE_WORDS):
    from PIL import Image, ImageDraw

    with Image.open(FACE) as im:
        face = im.convert("RGB").resize((360, 480))
    plain_png = tmp_path / "plain.png"
    face.save(plain_png)
    cap = face.copy()
    draw = ImageDraw.Draw(cap)
    for x0, x1 in words:
        draw.rectangle((x0, 220, x1, 260), fill=(255, 220, 0))
    # the dark scrim of a two-tier preset around the words is not caption text (D-98)
    draw.rectangle((0, 262, 359, 300), fill=(20, 20, 20))
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
    # the face is in front: the words' yellow is gone where the face covers them, kept elsewhere
    px = behind.frame_at("ffmpeg", out, 500, 360, 480, "bt601").astype(int)
    covered, edge = px[240, 120], px[240, 30]
    assert edge[2] < 80 and edge[0] > 200  # yellow
    assert not (covered[2] < 80 and covered[0] > 200 and covered[1] > 180)
    # again: every matte comes from the cache
    code, again, err = run_tool("behind", req, timeout=600)
    assert code == 0, err
    assert again["mattes"]["computed"] == 0 and again["mattes"]["cached"] > 0
    assert np.isclose(again["beats"][0]["overlap"], result["beats"][0]["overlap"])


@needs_vision
@needs_ffmpeg
def test_behind_keeps_a_word_on_the_face_in_front(tmp_path):
    # D-98 (owner demo, run 2): words centred on the face were hidden behind it
    cap, plain = renders(tmp_path, FACE_WORD)
    req = {
        "captioned": str(cap),
        "plain": str(plain),
        "output": str(tmp_path / "out.mp4"),
        "beats": [{"startMs": 0, "endMs": 1000}],
        "mode": "auto",
        "encoder": {"codec": "libx264", "crf": 12},
    }
    code, result, err = run_tool("behind", req, timeout=600)
    assert code == 0, err
    assert result["beats"][0]["overlap"] > 0.9
    assert result["beats"][0]["behind"] is False
    assert result["composited"] == 0


def test_words_split_at_gaps_and_the_worst_word_counts():
    cap = np.zeros((20, 300), bool)
    cap[5:15, 10:60] = True
    cap[5:15, 62:90] = True  # 2 columns apart: letters of one word
    cap[5:15, 150:250] = True  # far apart: a second word
    assert behind.words_of(cap) == [(10, 90), (150, 250)]
    subj = np.zeros_like(cap)
    subj[:, 150:230] = True  # 80 % of the second word
    assert behind.worst_word(cap, subj) == pytest.approx(0.8)

