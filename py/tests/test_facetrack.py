"""facetrack: Apple Vision faces (D-82; MediaPipe BlazeFace as the fallback) + Vision body and
saliency boxes at 12 fps on 360p (D-15)."""

import os
import sys
import threading
from pathlib import Path

import numpy as np
import pytest
from conftest import PY_ROOT, fixture_file, run_tool, stderr_error, validate

from vox_py import _tool, facetrack

darwin_only = pytest.mark.skipif(sys.platform != "darwin", reason="Apple Vision is macOS only")

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
    faces, bodies, saliency = facetrack.vision_detect(frame)
    assert faces == []
    assert bodies == []
    assert saliency is not None
    cx, cy = 460 / 640, 190 / 360
    assert saliency["x"] <= cx <= saliency["x"] + saliency["w"]
    assert saliency["y"] <= cy <= saliency["y"] + saliency["h"]


# ---- Vision first, BlazeFace per frame as the fallback (D-82; fast tier, fake detectors) ----


def fake_detector(monkeypatch, vision_faces, vision=True):
    """A Detector whose Vision and BlazeFace answers are canned; records the BlazeFace calls."""
    calls = []

    def fake_vision(frame, min_score):
        out = vision_faces(int(frame[0, 0, 0]))
        if isinstance(out, Exception):
            raise out
        return out, [box(0.1, 0.1, 0.5, 0.8)], box(0.2, 0.2, 0.3, 0.3)

    monkeypatch.setattr(facetrack, "vision_detect", fake_vision)
    detect = facetrack.Detector(Path("unused.tflite"), 0.5, vision=vision)

    def fake_blazeface(frame):
        calls.append(int(frame[0, 0, 0]))
        return [box(0.6, 0.2, 0.1, 0.2, 0.7)]

    monkeypatch.setattr(detect, "faces", fake_blazeface)
    return detect, calls


def frame_no(i):
    return np.full((4, 4, 3), i, dtype=np.uint8)


def test_vision_faces_are_used_and_blazeface_does_not_run(monkeypatch):
    detect, calls = fake_detector(monkeypatch, lambda i: [box(0.4, 0.2, 0.1, 0.2, 0.9)])
    faces, bodies, saliency, fell_back = detect.detect(frame_no(1))
    assert faces == [box(0.4, 0.2, 0.1, 0.2, 0.9)]
    assert bodies and saliency is not None
    assert fell_back is False and calls == []


def test_blazeface_runs_only_on_a_frame_where_vision_finds_no_face(monkeypatch):
    detect, calls = fake_detector(monkeypatch, lambda i: [] if i % 2 else [box(0.4, 0.2, 0.1, 0.2)])
    out = [detect.detect(frame_no(i)) for i in range(6)]
    assert calls == [1, 3, 5]
    assert [o[3] for o in out] == [False, True, False, True, False, True]
    # the fallback frame keeps Vision's bodies and saliency
    assert out[1][0] == [box(0.6, 0.2, 0.1, 0.2, 0.7)] and out[1][1] and out[1][2] is not None


def test_without_vision_blazeface_finds_every_frame_and_bodies_are_empty(monkeypatch):
    detect, calls = fake_detector(monkeypatch, lambda i: [box(0.4, 0.2, 0.1, 0.2)], vision=False)
    assert detect.detect(frame_no(7)) == ([box(0.6, 0.2, 0.1, 0.2, 0.7)], [], None, True)
    assert calls == [7]


def test_a_vision_failure_on_the_first_frame_turns_vision_off(monkeypatch):
    failed = _tool.ToolError("VISION_FAILED", "Could not create inference context")
    detect, calls = fake_detector(monkeypatch, lambda i: failed)
    assert facetrack.first_frame(detect, frame_no(2))[3] is True
    assert detect.vision is False and calls == [2]
    # any other error is still an error
    detect, _ = fake_detector(monkeypatch, lambda i: _tool.ToolError("TOOL_FAILED", "x"))
    with pytest.raises(_tool.ToolError):
        facetrack.first_frame(detect, frame_no(2))


def test_detector_version_is_2():
    # The engine's DETECTOR_VERSION (stages/facetrack.ts) must match: it re-detects other versions.
    assert facetrack.DETECTOR_VERSION == 2


# ---- real models on generated fixtures (local tier) ----


@darwin_only
@pytest.mark.local
def test_vision_finds_both_faces_on_face_2people_without_the_fallback(face_model):
    code, result, stderr = run_tool(
        "facetrack",
        {"videoPath": str(fixture_file("face-2people.mp4")), "faceModelPath": str(face_model)},
    )
    assert code == 0, stderr
    validate("facetrack.result.json", result)
    assert result["detector"] == {"version": 2, "faces": "vision", "fallbackSamples": 0}
    samples = result["samples"]
    assert all(len(s["faces"]) == 2 for s in samples), [len(s["faces"]) for s in samples]
    for s in samples:
        left, right = sorted(s["faces"], key=lambda f: f["x"])
        assert left["w"] * left["h"] > 2 * right["w"] * right["h"]  # the 30 px face, no tiles
        assert all(0.5 <= f["score"] <= 1 for f in s["faces"])


@darwin_only
@pytest.mark.local
def test_vision_faces_on_the_talking_head_match_blazeface(face_model, monkeypatch):
    request = {
        "videoPath": str(
            PY_ROOT.parent / "packages/engine/test/fixtures/assets/media/talking-head-20s.mp4"
        ),
        "faceModelPath": str(face_model),
    }
    new = facetrack.handle(dict(request))
    assert new["detector"]["faces"] == "vision" and new["detector"]["fallbackSamples"] == 0
    monkeypatch.setattr(facetrack, "vision_available", lambda: False)
    old = facetrack.handle(dict(request))
    assert old["detector"] == {"version": 2, "faces": "blazeface", "fallbackSamples": 240}
    assert all(s["bodies"] == [] and s["saliency"] is None for s in old["samples"])
    # one face per sample from both; Vision's box covers the same face (A/B in D-82)
    for a, b in zip(old["samples"], new["samples"], strict=True):
        assert len(a["faces"]) == len(b["faces"]) == 1
        fa, fb = a["faces"][0], b["faces"][0]
        inter = max(0, min(fa["x"] + fa["w"], fb["x"] + fb["w"]) - max(fa["x"], fb["x"])) * max(
            0, min(fa["y"] + fa["h"], fb["y"] + fb["h"]) - max(fa["y"], fb["y"])
        )
        assert inter / (fa["w"] * fa["h"] + fb["w"] * fb["h"] - inter) > 0.5
        assert abs((fa["x"] + fa["w"] / 2) - (fb["x"] + fb["w"] / 2)) < 0.05


@pytest.mark.local
def test_cuts_2shot_blazeface_runs_only_on_the_no_face_shot(face_model):
    code, result, stderr = run_tool(
        "facetrack",
        {"videoPath": str(fixture_file("cuts-2shot.mp4")), "faceModelPath": str(face_model)},
    )
    assert code == 0, stderr
    no_face = [s for s in result["samples"] if not s["faces"]]
    assert result["detector"]["faces"] == "vision"
    assert result["detector"]["fallbackSamples"] == len(no_face) > 0


@pytest.mark.local
def test_blazeface_fallback_with_tiles_finds_both_faces_on_face_2people(face_model, monkeypatch):
    # Without Vision (D-82 fallback) the D-21 tiles still find the 30 px face.
    monkeypatch.setattr(facetrack, "vision_available", lambda: False)
    request = {"videoPath": str(fixture_file("face-2people.mp4")), "faceModelPath": str(face_model)}
    result = facetrack.handle(request)
    validate("facetrack.result.json", result)
    assert result["detector"]["faces"] == "blazeface"
    two = [s for s in result["samples"] if len(s["faces"]) == 2]
    assert len(two) >= 0.9 * len(result["samples"])


@pytest.mark.local
def test_finds_both_faces_on_face_2people(face_model):
    video = fixture_file("face-2people.mp4")
    request = {"videoPath": str(video), "faceModelPath": str(face_model)}
    validate("facetrack.request.json", request)
    code, result, stderr = run_tool("facetrack", request)
    assert code == 0, stderr
    validate("facetrack.result.json", result)
    assert result["sampleFps"] == 12 and result["height"] == 360 and result["width"] == 640
    assert result["faceModel"]["sha256"] == facetrack.FACE_MODEL_SHA256
    assert result["detector"]["version"] == facetrack.DETECTOR_VERSION
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


# ---- parallel detection (decision "Quick clips speed") ----


def test_ordered_map_keeps_order_and_reads_ahead_at_most_two_per_worker():
    import threading
    import time

    read = []
    done = []
    lock = threading.Lock()

    def items():
        for i in range(40):
            read.append(i)
            yield i

    def slow(i):
        time.sleep(0.002 * (i % 3))
        with lock:
            done.append(i)
        return i * i

    out = []
    for r in facetrack.ordered_map(slow, items(), 4):
        # Never more than 2 × 4 items taken from the source beyond those already returned.
        assert len(read) - len(out) <= 8
        out.append(r)
    assert out == [i * i for i in range(40)]
    assert sorted(done) == list(range(40))


def test_ordered_map_with_one_worker_runs_inline():
    assert list(facetrack.ordered_map(lambda x: x + 1, iter([1, 2, 3]), 1)) == [2, 3, 4]


def test_ordered_map_raises_the_first_error_in_order():
    def fn(i):
        if i == 5:
            raise ValueError("bad frame")
        return i

    results = facetrack.ordered_map(fn, iter(range(20)), 3)
    assert [next(results) for _ in range(5)] == [0, 1, 2, 3, 4]
    with pytest.raises(ValueError, match="bad frame"):
        next(results)


@pytest.mark.local
def test_parallel_detection_matches_one_thread(face_model, monkeypatch):
    request = {"videoPath": str(fixture_file("face-2people.mp4")), "faceModelPath": str(face_model)}
    monkeypatch.setattr(facetrack, "WORKERS", 1)
    one = facetrack.handle(dict(request))
    monkeypatch.setattr(facetrack, "WORKERS", 4)
    four = facetrack.handle(dict(request))
    assert four == one
    assert len(one["samples"]) >= 58


def test_ordered_run_runs_each_stage_beside_the_others_in_item_order():
    # Faces (CPU) and Vision (Neural Engine) of one frame run at the same time on their own pools:
    # each fake stage only returns once the other stage of the same item has started.
    n = 30
    face_in = [threading.Event() for _ in range(n)]
    vision_in = [threading.Event() for _ in range(n)]

    def vision(i):
        vision_in[i].set()
        return ("vision", i, face_in[i].wait(5))

    def faces(i):
        face_in[i].set()
        return ("faces", i, vision_in[i].wait(5))

    out = list(facetrack.ordered_run(iter(range(n)), [(vision, 2), (faces, 4)]))
    assert out == [(("vision", i, True), ("faces", i, True)) for i in range(n)]


def test_ordered_run_reads_ahead_at_most_two_per_worker_of_the_largest_pool():
    read = []

    def items():
        for i in range(40):
            read.append(i)
            yield i

    out = []
    for r in facetrack.ordered_run(items(), [(lambda i: -i, 2), (lambda i: i * i, 4)]):
        assert len(read) - len(out) <= 8
        out.append(r)
    assert out == [(-i, i * i) for i in range(40)]


def test_ordered_run_with_one_worker_each_runs_the_stages_inline_in_order():
    calls = []

    def stage(name):
        def fn(i):
            calls.append((name, i, threading.current_thread() is threading.main_thread()))
            return name

        return fn

    out = list(facetrack.ordered_run(iter([1, 2]), [(stage("vision"), 1), (stage("faces"), 1)]))
    assert out == [("vision", "faces"), ("vision", "faces")]
    assert calls == [
        ("vision", 1, True),
        ("faces", 1, True),
        ("vision", 2, True),
        ("faces", 2, True),
    ]


def test_ordered_run_raises_the_first_error_in_order():
    def fn(i):
        if i == 5:
            raise ValueError("bad frame")
        return i

    results = facetrack.ordered_run(iter(range(20)), [(lambda i: i, 2), (fn, 3)])
    assert [next(results)[1] for _ in range(5)] == [0, 1, 2, 3, 4]
    with pytest.raises(ValueError, match="bad frame"):
        next(results)
