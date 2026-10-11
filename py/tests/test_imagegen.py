"""imagegen: mflux Z-Image-Turbo (engine "Image generation provider"; phase 14d)."""

import os
from pathlib import Path

import pytest
from conftest import run_tool, stderr_error, validate
from vox_py import imagegen


def test_plan_size_snaps_to_16_and_caps_the_pixels():
    w, h = imagegen.plan_size(1080, 1920)
    assert w % 16 == 0 and h % 16 == 0
    assert w * h <= imagegen.MAX_GEN_PIXELS + 16 * max(w, h)
    assert abs(w / h - 1080 / 1920) < 0.02


def test_plan_size_keeps_a_small_request_usable():
    w, h = imagegen.plan_size(64, 64)
    assert (w, h) == (256, 256)
    w, h = imagegen.plan_size(512, 512)
    assert (w, h) == (512, 512)


def test_unknown_action_and_fields_are_refused(tmp_path):
    code, _, stderr = run_tool("imagegen", {"action": "dance", "model": "z-image-turbo", "modelDir": str(tmp_path)})
    assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST"
    code, _, stderr = run_tool(
        "imagegen", {"action": "generate", "model": "z-image-turbo", "modelDir": str(tmp_path), "x": 1}
    )
    assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST"


def test_unknown_model_is_refused(tmp_path):
    code, _, stderr = run_tool("imagegen", {"action": "generate", "model": "sdxl", "modelDir": str(tmp_path)})
    assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST"


def test_generate_without_an_installed_model_says_so(tmp_path):
    request = {
        "action": "generate",
        "model": "z-image-turbo",
        "modelDir": str(tmp_path / "nope"),
        "prompt": "a red cup",
        "output": str(tmp_path / "o.png"),
    }
    validate("imagegen.request.json", request)
    code, _, stderr = run_tool("imagegen", request)
    assert code == 1 and stderr_error(stderr)["code"] == "MODEL_MISSING"


def test_install_needs_a_cache_dir(tmp_path):
    code, _, stderr = run_tool(
        "imagegen", {"action": "install", "model": "z-image-turbo", "modelDir": str(tmp_path / "m")}
    )
    assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST"


def installed_model() -> Path:
    tools = os.environ.get("VOX_TOOLS_DIR") or str(
        Path.home() / "Library/Application Support/Vox Studio/tools"
    )
    path = Path(tools) / "models/mflux/z-image-turbo"
    if not (path / imagegen.MANIFEST).is_file():
        pytest.fail(f"missing {path}; run `vox imagegen install` once (it downloads the model)")
    return path


@pytest.mark.local
def test_generate_writes_a_png_of_the_requested_size_offline(tmp_path):
    from PIL import Image

    out = tmp_path / "gen.png"
    request = {
        "action": "generate",
        "model": "z-image-turbo",
        "modelDir": str(installed_model()),
        "prompt": "a paper cutout of a red teapot on a plain table",
        "width": 576,
        "height": 1024,
        "seed": 7,
        "output": str(out),
    }
    validate("imagegen.request.json", request)
    code, result, stderr = run_tool("imagegen", request)
    assert code == 0, stderr
    validate("imagegen.result.json", result)
    with Image.open(out) as im:
        assert im.size == (576, 1024)
        assert im.getextrema() != ((0, 0), (0, 0), (0, 0))
