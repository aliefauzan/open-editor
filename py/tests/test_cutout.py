"""cutout: rembg with the pinned U^2-Net model (engine "Stages", `assets cutout`; phase 05 step 3)."""

import os
from pathlib import Path

import pytest
from conftest import REPO_ROOT, run_tool, stderr_error, validate

FACE = REPO_ROOT / "packages/engine/test/fixtures/assets/faces/face-a.jpg"


def model_path() -> Path:
    tools = os.environ.get("VOX_TOOLS_DIR") or str(
        Path.home() / "Library/Application Support/Vox Studio/tools"
    )
    path = Path(tools) / "models/rembg/u2net.onnx"
    if not path.is_file():
        pytest.fail(f"missing cutout model {path}; run `vox assets cutout` once (it downloads it)")
    return path


@pytest.mark.local
def test_cutout_writes_an_rgba_png_with_transparent_background(tmp_path):
    from PIL import Image

    out = tmp_path / "cut.png"
    request = {"input": str(FACE), "output": str(out), "modelPath": str(model_path())}
    validate("cutout.request.json", request)
    code, result, stderr = run_tool("cutout", request)
    assert code == 0, stderr
    validate("cutout.result.json", result)
    with Image.open(out) as im:
        assert im.mode == "RGBA"
        assert im.size == (result["width"], result["height"])
        alpha = im.getchannel("A")
        lo, hi = alpha.getextrema()
        assert lo == 0 and hi == 255
        # a portrait: the subject is kept, the corners are cut away
        assert alpha.getpixel((0, 0)) < 16
    assert 0.05 < result["coverage"] < 0.95


def test_wrong_model_file_is_refused(tmp_path):
    fake = tmp_path / "u2net.onnx"
    fake.write_bytes(b"not a model")
    code, _, stderr = run_tool(
        "cutout", {"input": str(FACE), "output": str(tmp_path / "o.png"), "modelPath": str(fake)}
    )
    assert code == 1
    assert stderr_error(stderr)["code"] == "MODEL_HASH_MISMATCH"


def test_other_model_names_are_refused(tmp_path):
    other = tmp_path / "bria-rmbg.onnx"
    other.write_bytes(b"x")
    code, _, stderr = run_tool(
        "cutout", {"input": str(FACE), "output": str(tmp_path / "o.png"), "modelPath": str(other)}
    )
    assert code == 1
    assert stderr_error(stderr)["code"] == "MODEL_MISSING"
