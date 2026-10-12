"""Cutout: background removal for `assets cutout` (engine "Stages"; D-72).

Run as `python -I -m vox_py.cutout`. Request: `{ input, output, modelPath? }`.

Apple Vision subject lift (`VNGenerateForegroundInstanceMaskRequest`, macOS 14+) runs first: it needs no
model download and gives a full-resolution soft mask of all foreground instances. rembg with the
pinned U^2-Net model is the fallback, used only when Vision is not available (another OS, macOS 13, a
failing request) or finds no subject. The fallback needs `modelPath`: the engine downloads
`u2net.onnx` (Apache-2.0, SHA-256 pinned in R5) into `<tools>/models/rembg/` when this tool reports
MODEL_MISSING, then runs it again with the path. This tool never downloads anything and never uses
rembg's default model (`bria-rmbg` is non-commercial, R5). A given `modelPath` is always checked.

Result: `{ output, width, height, coverage, engine }`; `output` is an RGBA PNG, `coverage` the share
of pixels with alpha above one half (4 places) and `engine` is `vision` or `rembg`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from . import _tool

MODEL_NAME = "u2net"
MODEL_FILE = "u2net.onnx"
MODEL_SHA256 = "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491"
# Decoding limit for untrusted images (about 12k × 12k), applied before Vision or rembg sees pixels.
MAX_PIXELS = 150_000_000

REQUEST: _tool.Spec = {
    "input": (str, True),
    "output": (str, True),
    "modelPath": (str, False),
}


def checked_model(raw: str | None) -> Path | None:
    """The given model path after the name and SHA-256 checks, or None when none was given."""
    if raw is None:
        return None
    model = Path(raw)
    if model.name != MODEL_FILE or not model.is_file():
        raise _tool.ToolError("MODEL_MISSING", f"cutout model not found: {model}")
    _tool.check_sha256(model, MODEL_SHA256, "cutout model")
    return model


def load_rgb(src: Path) -> Any:
    """The image as RGB, refused above MAX_PIXELS before any pixel is decoded."""
    from PIL import Image, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(src) as im:
            if im.width * im.height > MAX_PIXELS:
                raise _tool.ToolError(
                    "MEDIA_UNREADABLE",
                    f"the image is too large ({im.width}x{im.height}, limit {MAX_PIXELS} pixels)",
                )
            im.load()
            return im.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"cannot read the image: {exc}") from exc


def vision_available() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Vision
    except ImportError:
        return False
    # PyObjC resolves classes at run time: the request is missing before macOS 14.
    return hasattr(Vision, "VNGenerateForegroundInstanceMaskRequest")


def vision_alpha(rgb: Any) -> Any | None:
    """Alpha (uint8, source size) of all foreground instances, or None when Vision finds none."""
    import numpy as np
    import objc
    import Quartz
    import Vision

    from .facetrack import _cgimage

    frame = np.asarray(rgb, dtype=np.uint8)
    with objc.autorelease_pool():
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            _cgimage(frame), None
        )
        req = Vision.VNGenerateForegroundInstanceMaskRequest.alloc().init()
        ok, _err = handler.performRequests_error_([req], None)
        if not ok:
            return None
        results = req.results() or []
        if not results:
            return None
        obs = results[0]
        instances = obs.allInstances()
        if instances is None or instances.count() == 0:
            return None
        # Scaled to the handler's image (the source size), soft edges kept: no low-res mask stretch.
        buf, _err = obs.generateScaledMaskForImageForInstances_fromRequestHandler_error_(
            instances, handler, None
        )
        if buf is None:
            return None
        lock = Quartz.kCVPixelBufferLock_ReadOnly
        Quartz.CVPixelBufferLockBaseAddress(buf, lock)
        try:
            width = Quartz.CVPixelBufferGetWidth(buf)
            height = Quartz.CVPixelBufferGetHeight(buf)
            row = Quartz.CVPixelBufferGetBytesPerRow(buf)
            if (width, height) != (frame.shape[1], frame.shape[0]):
                return None
            base = Quartz.CVPixelBufferGetBaseAddress(buf)
            # One 32-bit float per pixel (kCVPixelFormatType_OneComponent32Float), rows padded.
            mask = (
                np.frombuffer(base.as_buffer(row * height), dtype=np.float32)
                .reshape(height, row // 4)[:, :width]
                .copy()
            )
        finally:
            Quartz.CVPixelBufferUnlockBaseAddress(buf, lock)
    return np.clip(mask * 255.0 + 0.5, 0, 255).astype(np.uint8)


def rembg_cut(rgb: Any, model: Path) -> Any:
    # rembg finds an existing model through U2NET_HOME and only downloads a missing one, which
    # checked_model rules out.
    os.environ["U2NET_HOME"] = str(model.parent)
    _tool.progress(0.4, "loading model")
    from rembg import new_session, remove

    session = new_session(MODEL_NAME, providers=["CPUExecutionProvider"])
    _tool.progress(0.5, "removing background")
    cut = remove(rgb, session=session)
    return cut if cut.mode == "RGBA" else cut.convert("RGBA")


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    src = _tool.existing_file(req["input"])
    model = checked_model(req.get("modelPath"))
    out = Path(req["output"])
    if out.suffix.lower() != ".png" or not out.parent.is_dir():
        raise _tool.ToolError("INVALID_REQUEST", "output must be a .png in an existing folder")

    rgb = load_rgb(src)
    alpha = None
    if vision_available():
        _tool.progress(0.1, "finding the subject")
        alpha = vision_alpha(rgb)
    if alpha is not None:
        from PIL import Image

        cut = rgb.copy()
        cut.putalpha(Image.fromarray(alpha, "L"))
        engine = "vision"
    else:
        if model is None:
            raise _tool.ToolError(
                "MODEL_MISSING",
                "Apple Vision found no subject or is not available, and the fallback needs "
                "the cutout model u2net.onnx (modelPath)",
            )
        _tool.progress(0.3, "no subject from Apple Vision, using rembg")
        cut = rembg_cut(rgb, model)
        engine = "rembg"

    hist = cut.getchannel("A").histogram()
    opaque = sum(hist[128:])
    total = cut.width * cut.height
    cut.save(out, format="PNG")
    _tool.progress(1.0, "done")
    return {
        "output": str(out),
        "width": cut.width,
        "height": cut.height,
        "coverage": round(opaque / total, 4) if total else 0.0,
        "engine": engine,
    }


if __name__ == "__main__":
    _tool.main(handle)
