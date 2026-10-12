"""grain: the noise level of a reference video's flat mid-tone areas (styles Part C, D-93)."""

import subprocess

import numpy as np
from conftest import run_tool, stderr_error, validate

from vox_py import grain


def test_grain_estimate_follows_added_noise():
    rng = np.random.default_rng(1)
    flat = np.full((720, 405), 128.0)
    assert grain.noise_sigma(flat) == 0.0
    for sigma in (2.0, 6.0):
        est = grain.noise_sigma(flat + rng.normal(0, sigma, flat.shape))
        # the flat-pixel selection keeps the quieter half: a steady, slightly low estimate
        assert 0.6 * sigma <= est <= 1.1 * sigma, (sigma, est)
    quiet = grain.noise_sigma(flat + rng.normal(0, 2.0, flat.shape))
    loud = grain.noise_sigma(flat + rng.normal(0, 6.0, flat.shape))
    assert loud > 2.5 * quiet


def test_grain_ignores_edges_and_clipped_areas():
    rng = np.random.default_rng(2)
    img = np.full((720, 405), 120.0)
    img[:, ::8] = 230.0  # hard stripes (texture, not noise)
    noisy = img + rng.normal(0, 3.0, img.shape)
    est = grain.noise_sigma(noisy)
    assert est is not None and est < 4.5
    # all black or white: grain is clipped there, nothing to measure
    assert grain.noise_sigma(np.full((720, 405), 10.0)) is None
    assert grain.noise_sigma(np.full((720, 405), 250.0)) is None


def test_grain_tool_on_a_noisy_clip(tmp_path):
    clip = tmp_path / "noise.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=gray:s=360x640:d=2,noise=alls=12:allf=t",
            "-c:v",
            "libx264",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            str(clip),
        ],
        check=True,
    )
    request = {"videoPath": str(clip), "atMs": [0, 1000, 60000], "shortSide": 360}
    validate("grain.request.json", request)
    code, result, err = run_tool("grain", request)
    assert code == 0, err
    validate("grain.result.json", result)
    # the frame past the end has no estimate
    assert result["frames"] == 2 and result["perFrame"][2] is None
    assert result["sigma"] > 1.0


def test_grain_rejects_bad_times(tmp_path):
    video = tmp_path / "x.mp4"
    video.write_bytes(b"\0")
    code, _, err = run_tool("grain", {"videoPath": str(video), "atMs": []})
    assert code == 1
    assert stderr_error(err)["code"] == "INVALID_REQUEST"
