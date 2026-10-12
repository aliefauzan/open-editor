"""Frame cards: a short Apple Vision description of each still, as text for the agent (plan D-73).

Run as `python -I -m vox_py.framecard`. Request: `{ images, textLevel? }`: 1 to 100 image paths (the
stills `view_frames` / `view_media` read) and the text recognition level (`accurate`, the default, or
`fast`; plan D-73 has the measurements). One `VNImageRequestHandler` per image runs, at once:
- `VNClassifyImageRequest`: the labels above `LABEL_MIN` confidence, at most `LABEL_MAX`;
- `VNRecognizeTextRequest`: text lines (the `ocr` tool's request and line format);
- `VNDetectFaceRectanglesRequest`: face count and boxes;
- `VNGenerateAttentionBasedSaliencyImageRequest`: the saliency box (as in `facetrack`);
- `VNCalculateImageAestheticsScoresRequest` (macOS 15+, left out on 14): overall score and isUtility.

Result (`py/tests/schemas/framecard.result.json`): `{ version, textLevel, cards }`, one card per image
in request order. A missing, unreadable or empty (0×0) image, or a Vision failure, gives that card an
`error` instead of failing the whole call. `pyobjc-framework-Vision` is already a v1 dependency.
"""

from __future__ import annotations

import time

from . import _tool

# Bump when a card's content or meaning changes: the engine caches cards per still and version.
CARD_VERSION = 1
MAX_IMAGES = 100
# Decoding limit for untrusted images (about 12k × 12k), as in `cutout`.
MAX_PIXELS = 150_000_000
LABEL_MIN = 0.3
LABEL_MAX = 6
TEXT_LEVELS = ("fast", "accurate")
DEFAULT_TEXT_LEVEL = "accurate"

REQUEST: _tool.Spec = {
    "images": (list, True),
    "textLevel": (str, False),
}


def load(path: str):
    """The image at `path` as an RGB array (EXIF orientation applied)."""
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    src = _tool.existing_file(path)
    try:
        with Image.open(src) as im:
            im.load()
            rgb = ImageOps.exif_transpose(im).convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"cannot read the image: {exc}") from exc
    return np.asarray(rgb, dtype=np.uint8)


def _aesthetics_request():
    """The aesthetics request, or None where the class does not exist (macOS 14)."""
    import objc

    try:
        cls = objc.lookUpClass("VNCalculateImageAestheticsScoresRequest")
    except objc.nosuchclass_error:
        return None
    return cls.alloc().init()


def card(frame, accurate: bool = True) -> dict:
    """The card of one RGB frame. Raises ToolError for an empty frame or a Vision failure."""
    import objc
    import Vision

    from .facetrack import _cgimage, saliency_box, vision_box
    from .ocr import text_lines, text_request

    height, width = frame.shape[:2] if frame.ndim >= 2 else (0, 0)
    if width == 0 or height == 0:
        # Vision itself fails with Code=13 "zero-dimensioned image".
        raise _tool.ToolError("MEDIA_UNREADABLE", "the image is empty (0×0)")
    t0 = time.perf_counter()
    with objc.autorelease_pool():
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            _cgimage(frame), None
        )
        labels_req = Vision.VNClassifyImageRequest.alloc().init()
        text_req = text_request(accurate=accurate)
        faces_req = Vision.VNDetectFaceRectanglesRequest.alloc().init()
        saliency_req = Vision.VNGenerateAttentionBasedSaliencyImageRequest.alloc().init()
        aesthetics_req = _aesthetics_request()
        reqs = [labels_req, text_req, faces_req, saliency_req]
        if aesthetics_req is not None:
            reqs.append(aesthetics_req)
        ok, err = handler.performRequests_error_(reqs, None)
        if not ok:
            raise _tool.ToolError("VISION_FAILED", f"Apple Vision request failed: {err}")
        labels = sorted(
            (
                {"label": str(o.identifier()), "confidence": round(float(o.confidence()), 4)}
                for o in (labels_req.results() or [])
                if float(o.confidence()) > LABEL_MIN
            ),
            key=lambda x: -x["confidence"],
        )[:LABEL_MAX]
        faces = sorted(
            (vision_box(o) for o in (faces_req.results() or [])), key=lambda b: (b["x"], b["y"])
        )
        out = {
            "width": int(width),
            "height": int(height),
            "labels": labels,
            "text": text_lines(text_req),
            "faces": {"count": len(faces), "boxes": faces},
            "saliency": saliency_box(saliency_req),
        }
        if aesthetics_req is not None:
            obs = (aesthetics_req.results() or [None])[0]
            if obs is not None:
                out["aesthetics"] = {
                    "overall": round(min(max(float(obs.overallScore()), -1.0), 1.0), 4),
                    "utility": bool(obs.isUtility()),
                }
    out["ms"] = round((time.perf_counter() - t0) * 1000)
    return out


def one(path: str, accurate: bool) -> dict:
    """The card of the image at `path`, or `{ path, error }`."""
    try:
        return {"path": path, **card(load(path), accurate)}
    except _tool.ToolError as exc:
        return {"path": path, "error": {"code": exc.code, "message": exc.message}}
    except Exception as exc:  # noqa: BLE001 - one bad image must not fail the other cards
        return {"path": path, "error": {"code": "VISION_FAILED", "message": f"{exc}"}}


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    images = req["images"]
    if not (1 <= len(images) <= MAX_IMAGES) or not all(
        isinstance(p, str) and p and "\x00" not in p for p in images
    ):
        raise _tool.ToolError(
            "INVALID_REQUEST", f"images must be 1 to {MAX_IMAGES} non-empty paths"
        )
    level = req.get("textLevel", DEFAULT_TEXT_LEVEL)
    if level not in TEXT_LEVELS:
        raise _tool.ToolError("INVALID_REQUEST", "textLevel must be fast or accurate")
    cards = []
    for i, path in enumerate(images):
        cards.append(one(path, level == "accurate"))
        _tool.progress((i + 1) / len(images), f"card {i + 1} of {len(images)}")
    return {"version": CARD_VERSION, "textLevel": level, "cards": cards}


if __name__ == "__main__":
    _tool.main(handle)
