"""framecard: Apple Vision labels, text, faces, saliency and aesthetics per still (plan D-73)."""

import platform
import subprocess
import sys

import pytest
from conftest import REPO_ROOT, fixture_file, run_tool, stderr_error, validate

from vox_py import _tool, framecard

FACE = REPO_ROOT / "packages/engine/test/fixtures/assets/faces/face-a.jpg"

darwin = pytest.mark.skipif(sys.platform != "darwin", reason="Apple Vision is macOS only")


def macos_major() -> int:
    release = platform.mac_ver()[0]
    return int(release.split(".")[0]) if release else 0


def text_png(path, text: str) -> None:
    from PIL import Image, ImageDraw, ImageFont

    im = Image.new("RGB", (1080, 1920), (20, 20, 20))
    draw = ImageDraw.Draw(im)
    draw.text((80, 1300), text, fill=(255, 255, 255), font=ImageFont.load_default(size=80))
    im.save(path)


# ---- request checks (fast tier, any platform) ----


@pytest.mark.parametrize(
    "request_",
    [{}, {"images": []}, {"images": [""]}, {"images": ["a.png"], "textLevel": "best"}],
)
def test_framecard_rejects_a_bad_request(request_):
    with pytest.raises(_tool.ToolError) as exc:
        framecard.handle(request_)
    assert exc.value.code == "INVALID_REQUEST"


def test_framecard_rejects_more_than_the_image_limit():
    with pytest.raises(_tool.ToolError):
        framecard.handle({"images": ["a.png"] * (framecard.MAX_IMAGES + 1)})


# ---- real Apple Vision ----


@darwin
def test_framecard_face_image_has_people_one_face_and_a_saliency_box():
    request = {"images": [str(FACE)]}
    validate("framecard.request.json", request)
    code, result, stderr = run_tool("framecard", request)
    assert code == 0, stderr
    validate("framecard.result.json", result)
    assert result["version"] == framecard.CARD_VERSION
    assert result["textLevel"] == "accurate"
    card = result["cards"][0]
    assert card["path"] == str(FACE)
    assert "people" in [x["label"] for x in card["labels"]]
    assert card["faces"]["count"] == 1
    face = card["faces"]["boxes"][0]
    assert 0.1 < face["x"] + face["w"] / 2 < 0.9
    assert card["saliency"] is not None
    if macos_major() >= 15:
        assert -1 <= card["aesthetics"]["overall"] <= 1
    else:
        assert "aesthetics" not in card


@darwin
@pytest.mark.local
def test_framecard_talking_head_frame_has_two_faces(tmp_path):
    video = fixture_file("podcast-2face.mp4")
    still = tmp_path / "talking.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", "3", "-i", str(video), "-frames:v", "1", str(still)],
        check=True,
    )
    code, result, stderr = run_tool("framecard", {"images": [str(still)]})
    assert code == 0, stderr
    validate("framecard.result.json", result)
    card = result["cards"][0]
    assert card["faces"]["count"] == 2
    assert {"people", "adult"} <= {x["label"] for x in card["labels"]}


@darwin
@pytest.mark.parametrize("level", ["fast", "accurate"])
def test_framecard_reads_caption_text_at_both_levels(tmp_path, level):
    still = tmp_path / "caption.png"
    text_png(still, "MAPS TELL STORIES")
    code, result, stderr = run_tool("framecard", {"images": [str(still)], "textLevel": level})
    assert code == 0, stderr
    validate("framecard.result.json", result)
    lines = result["cards"][0]["text"]
    assert "MAPS TELL STORIES" in " ".join(ln["text"] for ln in lines).upper()
    assert lines[0]["box"]["y"] > 0.5  # drawn in the lower half


@darwin
def test_framecard_bad_images_get_their_own_error_and_the_rest_still_works(tmp_path):
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not an image")
    missing = tmp_path / "missing.png"
    request = {"images": [str(bad), str(FACE), str(missing)]}
    code, result, stderr = run_tool("framecard", request)
    assert code == 0, stderr
    validate("framecard.result.json", result)
    cards = result["cards"]
    assert [c.get("error", {}).get("code") for c in cards] == [
        "MEDIA_UNREADABLE",
        None,
        "INPUT_NOT_FOUND",
    ]
    assert cards[1]["faces"]["count"] == 1


@darwin
def test_framecard_empty_frame_is_an_error_not_a_vision_crash():
    import numpy as np

    with pytest.raises(_tool.ToolError) as exc:
        framecard.card(np.zeros((0, 0, 3), dtype=np.uint8))
    assert exc.value.code == "MEDIA_UNREADABLE"
    with pytest.raises(_tool.ToolError):
        framecard.card(np.zeros((4, 0, 3), dtype=np.uint8))


def test_framecard_whole_call_fails_only_on_a_bad_request():
    code, result, stderr = run_tool("framecard", {"images": "face.jpg"})
    assert code == 1 and result is None
    assert stderr_error(stderr)["code"] == "INVALID_REQUEST"
