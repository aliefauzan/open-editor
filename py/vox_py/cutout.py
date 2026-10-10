"""Cutout: background removal with rembg and the pinned U^2-Net model (engine "Stages", `assets cutout`).

Run as `python -I -m vox_py.cutout`. Request: `{ input, output, modelPath }`. The engine downloads
`u2net.onnx` (Apache-2.0, SHA-256 pinned in R5) into `<tools>/models/rembg/` first; this tool never
downloads anything and never uses rembg's default model (`bria-rmbg` is non-commercial, R5).
Result: `{ output, width, height, coverage }`; `output` is an RGBA PNG and `coverage` the share of
pixels with alpha above one half.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import _tool

MODEL_NAME = "u2net"
MODEL_FILE = "u2net.onnx"
MODEL_SHA256 = "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491"
# Decoding limit for untrusted images (about 12k × 12k).
MAX_PIXELS = 150_000_000

REQUEST: _tool.Spec = {
    "input": (str, True),
    "output": (str, True),
    "modelPath": (str, True),
}


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    src = _tool.existing_file(req["input"])
    model = Path(req["modelPath"])
    if model.name != MODEL_FILE or not model.is_file():
        raise _tool.ToolError("MODEL_MISSING", f"cutout model not found: {model}")
    _tool.check_sha256(model, MODEL_SHA256, "cutout model")
    out = Path(req["output"])
    if out.suffix.lower() != ".png" or not out.parent.is_dir():
        raise _tool.ToolError("INVALID_REQUEST", "output must be a .png in an existing folder")

    # rembg finds an existing model through U2NET_HOME and only downloads a missing one, which the
    # checks above rule out.
    os.environ["U2NET_HOME"] = str(model.parent)
    from PIL import Image, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    _tool.progress(0.05, "loading model")
    from rembg import new_session, remove

    session = new_session(MODEL_NAME, providers=["CPUExecutionProvider"])
    try:
        with Image.open(src) as im:
            im.load()
            rgb = im.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"cannot read the image: {exc}") from exc
    _tool.progress(0.3, "removing background")
    cut = remove(rgb, session=session)
    if cut.mode != "RGBA":
        cut = cut.convert("RGBA")
    alpha = cut.getchannel("A")
    hist = alpha.histogram()
    opaque = sum(hist[128:])
    total = cut.width * cut.height
    cut.save(out, format="PNG")
    _tool.progress(1.0, "done")
    return {
        "output": str(out),
        "width": cut.width,
        "height": cut.height,
        "coverage": round(opaque / total, 4) if total else 0.0,
    }


if __name__ == "__main__":
    _tool.main(handle)
