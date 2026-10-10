"""facetrack: MediaPipe faces + Apple Vision body and saliency boxes at 12 fps on 360p (D-15)."""

import os
from pathlib import Path

import numpy as np
import pytest
from conftest import PY_ROOT, fixture_file, run_tool, stderr_error, validate

from vox_py import _tool, facetrack

MODEL_CACHE = Path(os.environ.get("VOX_TEST_MODELS_DIR", PY_ROOT / "cache" / "models"))


@pytest.fixture(scope="module")
def face_model():
    # Network on first use: the pinned URL, checked against the pinned SHA-256.
    return facetrack.ensure_face_model(MODEL_CACHE)


# ---- pure helpers (fast tier) ----


def box(x, y, w, h, score=0.9):
    return {"x": x, "y": y, "w": w, "h": h, "score": score}


def test_tiles_cover_a_landscape_frame_with_squares():
    assert facetrack.tile_offsets(640, 360) == [
        (0, 0, 360, 360),
        (140, 0, 360, 360),
        (280, 0, 360, 360),
    ]


def test_tiles_cover_a_portrait_frame_with_squares():
    assert facetrack.tile_offsets(360, 640) == [
        (0, 0, 360, 360),
        (0, 140, 360, 360),
        (0, 280, 360, 360),
    ]


def test_square_frame_has_no_extra_tiles():
    assert facetrack.tile_offsets(360, 360) == []


def test_merge_keeps_the_best_of_overlapping_faces():
    a = box(0.29, 0.25, 0.15, 0.27, 0.82)
    b = box(0.28, 0.24, 0.17, 0.30, 0.95)  # same face from a tile, higher score
    c = box(0.70, 0.37, 0.07, 0.13, 0.88)  # the small face, only seen in a tile
    merged = facetrack.merge_boxes([a, b, c])
    assert merged == [b, c]


def test_merge_drops_a_partial_face_inside_a_bigger_one():
    whole = box(0.20, 0.20, 0.20, 0.30, 0.9)
    part = box(0.30, 0.25, 0.08, 0.15, 0.95)  # cut by a tile edge, inside `whole`
    assert facetrack.merge_boxes([whole, part]) == [whole]


def test_vision_rect_is_flipped_to_top_left_origin():
    out = facetrack.from_vision_rect(0.1, 0.2, 0.3, 0.4, 0.5)
    assert out == pytest.approx({"x": 0.1, "y": 0.4, "w": 0.3, "h": 0.4, "score": 0.5})


def test_boxes_are_clamped_to_the_frame():
    out = facetrack.clamp_box(box(-0.1, 0.9, 0.3, 0.3, 1.0))
    assert out == pytest.approx(box(0.0, 0.9, 0.2, 0.1, 1.0))


def test_scaled_size_puts_the_short_side_at_360_with_even_sides():
    assert facetrack.scaled_size(1920, 1080, 360) == (640, 360)
    assert facetrack.scaled_size(1080, 1920, 360) == (360, 640)
    assert facetrack.scaled_size(1000, 1000, 360) == (360, 360)
    assert facetrack.scaled_size(1280, 534, 360) == (862, 360)


def test_face_model_with_a_wrong_hash_is_refused(tmp_path):
    bad = tmp_path / "blaze_face_full_range.tflite"
    bad.write_bytes(b"not a model")
    with pytest.raises(_tool.ToolError) as info:
        facetrack.check_face_model(bad)
    assert info.value.code == "MODEL_HASH_MISMATCH"


@pytest.mark.local  # GitHub macOS VMs: Vision fails with "Could not create inference context"
def test_vision_finds_a_saliency_box_on_a_synthetic_frame():
    # A bright square on grey is the salient object.
    frame = np.full((360, 640, 3), 60, dtype=np.uint8)
    frame[150:230, 420:500] = (255, 230, 0)
    bodies, saliency = facetrack.vision_detect(frame)
    assert bodies == []
    assert saliency is not None
    cx, cy = 460 / 640, 190 / 360
    assert saliency["x"] <= cx <= saliency["x"] + saliency["w"]
    assert saliency["y"] <= cy <= saliency["y"] + saliency["h"]


# ---- real models on generated fixtures (local tier) ----


@pytest.mark.local
def test_mediapipe_finds_both_faces_on_face_2people(face_model):
    video = fixture_file("face-2people.mp4")
    request = {"videoPath": str(video), "faceModelPath": str(face_model)}
    validate("facetrack.request.json", request)
    code, result, stderr = run_tool("facetrack", request)
    assert code == 0, stderr
    validate("facetrack.result.json", result)
    assert result["sampleFps"] == 12 and result["height"] == 360 and result["width"] == 640
    assert result["faceModel"]["sha256"] == facetrack.FACE_MODEL_SHA256
    samples = result["samples"]
    assert 58 <= len(samples) <= 61  # 5 s at 12 fps
    assert [s["atMs"] for s in samples[:3]] == [0, 83, 167]
    two = [s for s in samples if len(s["faces"]) == 2]
    assert len(two) >= 0.9 * len(samples), [len(s["faces"]) for s in samples]
    for s in two:
        left, right = sorted(s["faces"], key=lambda f: f["x"])
        assert left["x"] + left["w"] / 2 < 0.5 < right["x"] + right["w"] / 2
        assert left["w"] * left["h"] > 2 * right["w"] * right["h"]  # face-a large, face-b small


@pytest.mark.local
def test_cuts_2shot_faces_then_vision_boxes_on_the_no_face_shot(face_model):
    video = fixture_file("cuts-2shot.mp4")
    code, result, stderr = run_tool(
        "facetrack", {"videoPath": str(video), "faceModelPath": str(face_model)}
    )
    assert code == 0, stderr
    validate("facetrack.result.json", result)
    samples = result["samples"]
    shot1 = [s for s in samples if 200 <= s["atMs"] <= 2800]
    shot2 = [s for s in samples if 3200 <= s["atMs"] <= 5800]
    shot3 = [s for s in samples if 6200 <= s["atMs"] <= 8800]
    assert shot1 and shot2 and shot3
    # Shot 1: face-a on the left; shot 2: face-b on the right; each with an upper-body box.
    for s in shot1:
        assert len(s["faces"]) == 1 and s["faces"][0]["x"] + s["faces"][0]["w"] / 2 < 0.5
        assert s["bodies"], s
    for s in shot2:
        assert len(s["faces"]) == 1 and s["faces"][0]["x"] + s["faces"][0]["w"] / 2 > 0.5
        assert s["bodies"], s
    # Shot 3 (no face): no faces, no bodies, a saliency box every sample.
    for s in shot3:
        assert s["faces"] == [] and s["bodies"] == [], s
        assert s["saliency"] is not None, s
    # The bright moving box (x = 500 px/s from the shot start, 140 px, y 450..590 of 1080)
    # lies inside the saliency box on most samples.
    hits = 0
    for s in shot3:
        t = (s["atMs"] - 6000) / 1000
        cx, cy = ((500 * t) % 1700 + 70) / 1920, 520 / 1080
        sal = s["saliency"]
        if sal["x"] <= cx <= sal["x"] + sal["w"] and sal["y"] <= cy <= sal["y"] + sal["h"]:
            hits += 1
    assert hits >= 0.7 * len(shot3), f"{hits}/{len(shot3)}"


@pytest.mark.local
def test_missing_video_fails_cleanly(face_model, tmp_path):
    code, _, stderr = run_tool(
        "facetrack",
        {"videoPath": str(tmp_path / "none.mp4"), "faceModelPath": str(face_model)},
    )
    assert code == 1
    assert stderr_error(stderr)["code"] == "INPUT_NOT_FOUND"
