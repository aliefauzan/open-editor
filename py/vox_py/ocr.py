"""On-screen text and caption timing through Apple Vision OCR (styles spec Part C, plan phase 15).

Run as `python -I -m vox_py.ocr`. Request: `{ videoPath, ffmpeg?, ffprobe?, formatWhitelist?, fps?,
shortSide?, minConfidence? }`. ffmpeg samples the video at `fps` (default 4) with its short side
scaled to `shortSide` (default 720); Apple Vision `VNRecognizeTextRequest` (accurate) reads each
frame. `pyobjc-framework-Vision` is already a v1 dependency (facetrack saliency, plan D-15).

Result (`py/tests/schemas/ocr.result.json`):
- `frames`: per sampled frame, the text lines with normalised top-left boxes and confidence;
- `static`: text seen on most frames (logos, watermarks), left out of the captions;
- `captions`: caption events. Per frame, the lines centred horizontally (centre x in 0.2–0.8) that are
  not static form the caption block; runs of the same block (fuzzy match) are one event. An event
  whose text grows word by word into the next one is merged into it (`reveal: true`);
- `summary`: caption count, median words per caption, median centre height (`yPct`), letter case,
  the share of word-by-word reveals, or `detected: false` when no caption was found.
"""

from __future__ import annotations

import difflib
import re
import statistics
from pathlib import Path

from . import _tool
from .facetrack import frames, probe, scaled_size

REQUEST: _tool.Spec = {
    "videoPath": (str, True),
    "ffmpeg": (str, False),
    "ffprobe": (str, False),
    "formatWhitelist": (str, False),
    "fps": ((int, float), False),
    "shortSide": (int, False),
    "minConfidence": ((int, float), False),
}

# A caption block sits around the horizontal centre.
CENTRE_MIN, CENTRE_MAX = 0.2, 0.8
# Text on at least this share of the frames (and on 8 frames or more) is a logo or watermark.
STATIC_SHARE = 0.8
STATIC_MIN_FRAMES = 8
SAME_TEXT = 0.85


def norm(text: str) -> str:
    """Case-folded words without punctuation, single spaces."""
    return " ".join(re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE).upper().split())


def same_text(a: str, b: str) -> bool:
    if a == b:
        return True
    if not a or not b:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= SAME_TEXT


def letter_case(text: str) -> str:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return "asis"
    if all(c.isupper() for c in letters):
        return "upper"
    if all(c.islower() for c in letters):
        return "lower"
    return "asis"


def recognise(frame) -> list[dict]:
    """Text lines of one RGB frame (Apple Vision accurate), boxes normalised with a top-left origin."""
    import objc
    import Vision

    from .facetrack import _cgimage

    with objc.autorelease_pool():
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            _cgimage(frame), None
        )
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        req.setUsesLanguageCorrection_(True)
        ok, err = handler.performRequests_error_([req], None)
        if not ok:
            raise _tool.ToolError("VISION_FAILED", f"Apple Vision text request failed: {err}")
        lines = []
        for obs in req.results() or []:
            cands = obs.topCandidates_(1)
            if not cands:
                continue
            r = obs.boundingBox()
            x, y, w, h = r.origin.x, r.origin.y, r.size.width, r.size.height
            lines.append(
                {
                    "text": str(cands[0].string()),
                    "box": {
                        "x": round(min(max(x, 0.0), 1.0), 4),
                        "y": round(min(max(1.0 - y - h, 0.0), 1.0), 4),
                        "w": round(min(max(w, 0.0), 1.0), 4),
                        "h": round(min(max(h, 0.0), 1.0), 4),
                    },
                    "confidence": round(float(cands[0].confidence()), 4),
                }
            )
        lines.sort(key=lambda ln: (ln["box"]["y"], ln["box"]["x"]))
        return lines


def static_texts(frame_lines: list[list[dict]]) -> set[str]:
    counts: dict[str, int] = {}
    for lines in frame_lines:
        for t in {norm(ln["text"]) for ln in lines}:
            if t:
                counts[t] = counts.get(t, 0) + 1
    n = len(frame_lines)
    return {t for t, c in counts.items() if c >= STATIC_MIN_FRAMES and c >= STATIC_SHARE * n}


def caption_block(lines: list[dict], static: set[str]) -> dict | None:
    picked = [
        ln
        for ln in lines
        if norm(ln["text"])
        and norm(ln["text"]) not in static
        and CENTRE_MIN <= ln["box"]["x"] + ln["box"]["w"] / 2 <= CENTRE_MAX
    ]
    if not picked:
        return None
    x0 = min(ln["box"]["x"] for ln in picked)
    y0 = min(ln["box"]["y"] for ln in picked)
    x1 = max(ln["box"]["x"] + ln["box"]["w"] for ln in picked)
    y1 = max(ln["box"]["y"] + ln["box"]["h"] for ln in picked)
    text = " ".join(ln["text"].strip() for ln in picked)
    box = {"x": round(x0, 4), "y": round(y0, 4), "w": round(x1 - x0, 4), "h": round(y1 - y0, 4)}
    return {"text": text, "box": box}


def caption_events(frame_lines: list[list[dict]], step_ms: float, static: set[str]) -> list[dict]:
    events: list[dict] = []
    cur: dict | None = None
    for i, lines in enumerate(frame_lines):
        block = caption_block(lines, static)
        at = round(i * step_ms)
        if block and cur and same_text(norm(block["text"]), norm(cur["text"])):
            cur["endMs"] = round((i + 1) * step_ms)
            continue
        if cur:
            events.append(cur)
            cur = None
        if block:
            cur = {**block, "startMs": at, "endMs": round((i + 1) * step_ms), "reveal": False}
    if cur:
        events.append(cur)
    # word-by-word reveal: "A" → "A B" → "A B C" becomes one caption "A B C"
    merged: list[dict] = []
    for e in events:
        prev = merged[-1] if merged else None
        if (
            prev
            and prev["endMs"] >= e["startMs"] - step_ms
            and norm(e["text"]).startswith(norm(prev["text"]))
            and len(norm(e["text"]).split()) > len(norm(prev["text"]).split())
        ):
            merged[-1] = {**e, "startMs": prev["startMs"], "reveal": True}
        else:
            merged.append(e)
    for e in merged:
        e["words"] = len(norm(e["text"]).split())
        e["case"] = letter_case(e["text"])
    return merged


def summarise(captions: list[dict]) -> dict:
    if not captions:
        return {"detected": False, "captionCount": 0}
    cases = [c["case"] for c in captions]
    case = max(("upper", "lower", "asis"), key=cases.count)
    return {
        "detected": True,
        "captionCount": len(captions),
        "wordsPerCaption": round(statistics.median(c["words"] for c in captions), 2),
        "yPct": round(
            100 * statistics.median(c["box"]["y"] + c["box"]["h"] / 2 for c in captions), 2
        ),
        "case": case,
        "revealShare": round(sum(1 for c in captions if c["reveal"]) / len(captions), 4),
        "medianCaptionMs": round(statistics.median(c["endMs"] - c["startMs"] for c in captions)),
    }


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    path: Path = _tool.existing_file(req["videoPath"])
    ffmpeg = req.get("ffmpeg", "ffmpeg")
    ffprobe = req.get("ffprobe", "ffprobe")
    formats = req.get("formatWhitelist", _tool.DEFAULT_FORMAT_WHITELIST)
    fps = _tool.number_in(req, "fps", 4.0, 0.5, 8.0)
    short_side = _tool.int_at_least(req, "shortSide", 720, 160, 1080)
    min_conf = _tool.number_in(req, "minConfidence", 0.3, 0.0, 1.0)

    width, height, duration_ms = probe(path, ffprobe, formats)
    w, h = scaled_size(width, height, short_side)
    total = max(1, round(duration_ms / 1000 * fps))
    step_ms = 1000.0 / fps
    frame_lines: list[list[dict]] = []
    out_frames: list[dict] = []
    for i, frame in enumerate(frames(path, ffmpeg, formats, fps, w, h)):
        lines = [ln for ln in recognise(frame) if ln["confidence"] >= min_conf]
        frame_lines.append(lines)
        out_frames.append({"atMs": round(i * step_ms), "lines": lines})
        if i % 4 == 0:
            _tool.progress(min(0.99, (i + 1) / total), f"text frame {i + 1} of {total}")
    static = static_texts(frame_lines)
    captions = caption_events(frame_lines, step_ms, static)
    return {
        "fps": fps,
        "width": w,
        "height": h,
        "durationMs": duration_ms,
        "frames": out_frames,
        "static": sorted(static),
        "captions": captions,
        "summary": summarise(captions),
    }


if __name__ == "__main__":
    _tool.main(handle)
