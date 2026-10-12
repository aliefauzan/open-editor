"""cutout: Apple Vision subject lift first, rembg with the pinned U^2-Net model as the fallback
(engine "Stages", `assets cutout`; phase 05 step 3, D-72)."""

import os
import sys
from pathlib import Path

import pytest
from conftest import REPO_ROOT, run_tool, stderr_error, validate

FACE = REPO_ROOT / "packages/engine/test/fixtures/assets/faces/face-a.jpg"


def vision_ready() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Vision
    except ImportError:
        return False
    return hasattr(Vision, "VNGenerateForegroundInstanceMaskRequest")


needs_vision = pytest.mark.skipif(
    not vision_ready(), reason="Apple Vision subject lift needs macOS 14+ with PyObjC Vision"
)


def flat_image(path: Path) -> Path:
    from PIL import Image

    Image.new("RGB", (320, 240), (40, 90, 200)).save(path)
    return path


def model_path() -> Path:
    tools = os.environ.get("VOX_TOOLS_DIR") or str(
        Path.home() / "Library/Application Support/Vox Studio/tools"
    )
    path = Path(tools) / "models/rembg/u2net.onnx"
    if not path.is_file():
        pytest.fail(f"missing cutout model {path}; run `vox assets cutout` once (it downloads it)")
    return path


def check_portrait(out: Path, result: dict) -> None:
    from PIL import Image

    with Image.open(out) as im:
        assert im.mode == "RGBA"
        assert im.size == (result["width"], result["height"])
        alpha = im.getchannel("A")
        lo, hi = alpha.getextrema()
        assert lo == 0 and hi == 255
        # a portrait: the subject is kept, the corners are cut away
        assert alpha.getpixel((0, 0)) < 16
    assert 0.05 < result["coverage"] < 0.95


@needs_vision
def test_vision_cuts_out_the_portrait_without_a_model(tmp_path):
    from PIL import Image

    out = tmp_path / "cut.png"
    request = {"input": str(FACE), "output": str(out)}
    validate("cutout.request.json", request)
    code, result, stderr = run_tool("cutout", request)
    assert code == 0, stderr
    validate("cutout.result.json", result)
    assert result["engine"] == "vision"
    with Image.open(FACE) as src:
        assert (result["width"], result["height"]) == src.size
    check_portrait(out, result)
    with Image.open(out) as im:
        # full-resolution soft mask: edge pixels between clear and opaque, not a hard stretched mask
        soft = sum(im.getchannel("A").histogram()[16:240])
        assert soft > 0


def test_no_subject_without_a_model_asks_for_the_fallback_model(tmp_path):
    code, _, stderr = run_tool(
        "cutout",
        {"input": str(flat_image(tmp_path / "flat.png")), "output": str(tmp_path / "o.png")},
    )
    assert code == 1
    error = stderr_error(stderr)
    assert error["code"] == "MODEL_MISSING"
    assert "u2net.onnx" in error["message"]
    assert not (tmp_path / "o.png").exists()


def test_unreadable_image_is_media_unreadable(tmp_path):
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image")
    code, _, stderr = run_tool("cutout", {"input": str(bad), "output": str(tmp_path / "o.png")})
    assert code == 1
    assert stderr_error(stderr)["code"] == "MEDIA_UNREADABLE"


def huge_png_header(path: Path, width: int, height: int) -> Path:
    """A PNG that declares a huge size but holds no pixel data (enough for the size check)."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b""))
    return path


def test_images_over_the_pixel_limit_are_refused_before_decoding(tmp_path):
    # 13000 x 13000 = 169 M pixels: above MAX_PIXELS (150 M), below Pillow's own 2x error.
    big = huge_png_header(tmp_path / "big.png", 13000, 13000)
    code, _, stderr = run_tool("cutout", {"input": str(big), "output": str(tmp_path / "o.png")})
    assert code == 1
    error = stderr_error(stderr)
    assert error["code"] == "MEDIA_UNREADABLE"
    assert "too large" in error["message"]


def test_output_must_be_a_png_in_an_existing_folder(tmp_path):
    for output in (tmp_path / "o.jpg", tmp_path / "missing" / "o.png"):
        code, _, stderr = run_tool("cutout", {"input": str(FACE), "output": str(output)})
        assert code == 1
        assert stderr_error(stderr)["code"] == "INVALID_REQUEST"


@pytest.mark.local
def test_no_subject_falls_back_to_rembg(tmp_path):
    from PIL import Image

    out = tmp_path / "flat-cut.png"
    request = {
        "input": str(flat_image(tmp_path / "flat.png")),
        "output": str(out),
        "modelPath": str(model_path()),
    }
    validate("cutout.request.json", request)
    code, result, stderr = run_tool("cutout", request)
    assert code == 0, stderr
    validate("cutout.result.json", result)
    assert result["engine"] == "rembg"
    with Image.open(out) as im:
        assert im.mode == "RGBA"
        assert im.size == (320, 240)


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
