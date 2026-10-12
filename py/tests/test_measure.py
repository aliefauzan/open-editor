"""measure: the palette tool (k-means k = 8 over keyframes; styles Part C, phase 15)."""

import json

import numpy as np
import pytest
from conftest import fixture_file, run_tool, stderr_error, validate

from vox_py import palette


def rgb(hex_: str) -> np.ndarray:
    return np.array([int(hex_[i : i + 2], 16) for i in (1, 3, 5)], dtype=float)


def test_measure_kmeans_finds_flat_colours_and_is_repeatable():
    colours = [(215, 38, 30), (29, 79, 160), (245, 197, 24)]
    px = np.concatenate(
        [np.tile(np.array(c, dtype=np.uint8), (100 * (i + 1), 1)) for i, c in enumerate(colours)]
    )
    c1, n1 = palette.kmeans(px, 8)
    c2, n2 = palette.kmeans(px, 8)
    assert np.array_equal(c1, c2) and np.array_equal(n1, n2)
    # three distinct pixels: at most three clusters
    assert len(c1) == 3
    assert sorted(n1.tolist()) == [100, 200, 300]


def test_measure_palette_rejects_bad_times(tmp_path):
    video = tmp_path / "x.mp4"
    video.write_bytes(b"\0")
    code, _, err = run_tool("palette", {"videoPath": str(video), "atMs": [-1]})
    assert code == 1
    assert stderr_error(err)["code"] == "INVALID_REQUEST"


@pytest.mark.local
def test_measure_palette_on_the_fixture_finds_each_shot_colour():
    clip = fixture_file("style-extract-10s.mp4")
    truth = json.loads(fixture_file("style-extract-10s.truth.json").read_text())
    # one keyframe per shot plus one per 2 s (as the engine picks them)
    request = {"videoPath": str(clip), "atMs": [1000, 3250, 5750, 8500, 0, 2000, 4000, 6000, 8000]}
    validate("palette.request.json", request)
    code, result, err = run_tool("palette", request)
    assert code == 0, err
    validate("palette.result.json", result)
    assert result["frames"] == 9
    assert len(result["colors"]) <= 8
    shares = [c["share"] for c in result["colors"]]
    assert shares == sorted(shares, reverse=True)
    assert abs(sum(shares) - 1) < 0.01
    for want in truth["shotColors"]:
        best = min(np.linalg.norm(rgb(c["hex"]) - rgb(want)) for c in result["colors"])
        assert best <= 20, f"{want} not in the palette ({best:.1f})"
