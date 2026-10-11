"""Face, body and saliency detections for framing (engine "Shots and framing", plan D-15).

Run as `python -I -m vox_py.facetrack`. Request: `{ videoPath, faceModelPath, ffmpeg?, ffprobe?,
formatWhitelist?, sampleFps? (12), shortSide? (360), minFaceScore? (0.5) }`. Result (written by the
engine as `facetracks/<mediaId>.json`): `{ sampleFps, width, height, durationMs, faceModel,
samples: { atMs, faces: Box[], bodies: Box[], saliency: Box | null }[] }`, where a Box is
`{ x, y, w, h, score }` normalised to the frame with the origin top-left.

- Frames: ffmpeg samples the video at `sampleFps` and scales its short side to `shortSide`.
- Faces: MediaPipe Tasks `FaceDetector` with the full-range BlazeFace model (pinned URL + SHA-256
  below). The detector squeezes the whole frame into its 192 px input, which loses small faces in a
  wide frame, so it also runs on square tiles along the long side; overlapping boxes are merged.
- Bodies: Apple Vision `VNDetectHumanRectanglesRequest` (upper body). Saliency: Vision
  `VNGenerateAttentionBasedSaliencyImageRequest`, the union of its salient objects.
The engine builds the crop path from these detections and the shot list (`stages/facetrack.ts`).

Speed (decision "Quick clips speed"): MediaPipe runs on the CPU and Vision on the Neural Engine, and
both release the GIL. Faces are found on `WORKERS` threads (a FaceDetector each) and Vision runs on
its own `VISION_WORKERS` threads at the same time, so the Neural Engine work overlaps the CPU work
instead of following it. Results come back in frame order and are the same as a single-threaded run.
"""

from __future__ import annotations

import itertools
import json
import os
import subprocess
import tempfile
import threading
import urllib.request
from collections import deque
from collections.abc import Callable, Iterable, Iterator, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import numpy as np

from . import _tool

FACE_MODEL_NAME = "blaze_face_full_range"
FACE_MODEL_FILE = "blaze_face_full_range.tflite"
FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_full_range/float16/1/blaze_face_full_range.tflite"
)
FACE_MODEL_SHA256 = "3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b"

DEFAULT_SAMPLE_FPS = 12
DEFAULT_SHORT_SIDE = 360
DEFAULT_MIN_FACE_SCORE = 0.5
# Face detection threads: the performance cores of an M-series Mac; more gives nothing (measured).
WORKERS = max(1, min(4, (os.cpu_count() or 1) // 2))
# Vision threads beside them: Vision mostly waits on the Neural Engine; 3 keeps it busy (measured).
VISION_WORKERS = 3
SAME_FACE_IOU = 0.3
SAME_FACE_INSIDE = 0.6

REQUEST: _tool.Spec = {
    "videoPath": (str, True),
    "faceModelPath": (str, True),
    "ffmpeg": (str, False),
    "ffprobe": (str, False),
    "formatWhitelist": (str, False),
    "sampleFps": ((int, float), False),
    "shortSide": (int, False),
    "minFaceScore": ((int, float), False),
}


# ---- face model ----


MAX_FACE_MODEL_BYTES = 8 << 20


def check_face_model(path: Path) -> None:
    if "\x00" in str(path) or not path.is_file():
        raise _tool.ToolError("MODEL_MISSING", f"face model not found: {path}")
    _tool.check_sha256(path, FACE_MODEL_SHA256, "MediaPipe face model")


def ensure_face_model(directory: Path) -> Path:
    """Download the pinned face model into `directory` once; always checks the SHA-256."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / FACE_MODEL_FILE
    if not path.is_file():
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".part")
        try:
            with (
                os.fdopen(fd, "wb") as out,
                urllib.request.urlopen(FACE_MODEL_URL, timeout=60) as r,
            ):
                out.write(r.read())
            check_face_model(Path(tmp))
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    check_face_model(path)
    return path


# ---- geometry helpers ----


def scaled_size(width: int, height: int, short_side: int) -> tuple[int, int]:
    """Frame size with the short side at `short_side` and both sides even."""

    def even(v: float) -> int:
        return max(2, round(v / 2) * 2)

    if width >= height:
        return even(width * short_side / height), even(short_side)
    return even(short_side), even(height * short_side / width)


def tile_offsets(width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Square tiles (x, y, w, h) along the long side: start, middle, end. None for a square."""
    if width == height:
        return []
    side = min(width, height)
    span = max(width, height) - side
    starts = sorted({0, span // 2, span})
    if width > height:
        return [(s, 0, side, side) for s in starts]
    return [(0, s, side, side) for s in starts]


def clamp_box(b: dict) -> dict:
    x0, y0 = max(0.0, b["x"]), max(0.0, b["y"])
    x1, y1 = min(1.0, b["x"] + b["w"]), min(1.0, b["y"] + b["h"])
    return {
        "x": round(x0, 4),
        "y": round(y0, 4),
        "w": round(max(0.0, x1 - x0), 4),
        "h": round(max(0.0, y1 - y0), 4),
        "score": round(min(max(b["score"], 0.0), 1.0), 4),
    }


def from_vision_rect(x: float, y: float, w: float, h: float, score: float) -> dict:
    """Vision boxes are normalised with the origin bottom-left; flip to top-left."""
    return clamp_box({"x": x, "y": 1.0 - y - h, "w": w, "h": h, "score": score})


def _area(b: dict) -> float:
    return b["w"] * b["h"]


def _intersection(a: dict, b: dict) -> float:
    iw = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    ih = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return max(0.0, iw) * max(0.0, ih)


def _same_face(a: dict, b: dict) -> bool:
    inter = _intersection(a, b)
    if inter <= 0:
        return False
    union = _area(a) + _area(b) - inter
    smaller = min(_area(a), _area(b))
    return inter / union > SAME_FACE_IOU or (smaller > 0 and inter / smaller > SAME_FACE_INSIDE)


def merge_boxes(boxes: list[dict]) -> list[dict]:
    """One box per face: of overlapping boxes keep the largest; result sorted by score."""
    kept: list[dict] = []
    for b in sorted(boxes, key=_area, reverse=True):
        if not any(_same_face(b, k) for k in kept):
            kept.append(b)
    return sorted(kept, key=lambda b: b["score"], reverse=True)


# ---- detectors ----


class FaceFinder:
    def __init__(self, model_path: Path, min_score: float):
        from mediapipe.tasks.python import BaseOptions, vision

        options = vision.FaceDetectorOptions(
            base_options=BaseOptions(
                model_asset_path=str(model_path), delegate=BaseOptions.Delegate.CPU
            ),
            min_detection_confidence=min_score,
        )
        self.detector = vision.FaceDetector.create_from_options(options)
        self.min_score = min_score

    def _detect(self, rgb: np.ndarray) -> list:
        import mediapipe as mp

        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        return self.detector.detect(image).detections

    def find(self, frame: np.ndarray) -> list[dict]:
        height, width = frame.shape[:2]
        regions = [(0, 0, width, height), *tile_offsets(width, height)]
        boxes = []
        for ox, oy, tw, th in regions:
            for d in self._detect(frame[oy : oy + th, ox : ox + tw]):
                score = d.categories[0].score if d.categories else 0.0
                if score < self.min_score:
                    continue
                bb = d.bounding_box
                boxes.append(
                    clamp_box(
                        {
                            "x": (ox + bb.origin_x) / width,
                            "y": (oy + bb.origin_y) / height,
                            "w": bb.width / width,
                            "h": bb.height / height,
                            "score": score,
                        }
                    )
                )
        return merge_boxes([b for b in boxes if b["w"] > 0 and b["h"] > 0])

    def close(self) -> None:
        self.detector.close()


def _cgimage(frame: np.ndarray):
    import Quartz
    from Foundation import NSData

    height, width = frame.shape[:2]
    rgba = np.concatenate([frame, np.full((height, width, 1), 255, np.uint8)], axis=2).tobytes()
    provider = Quartz.CGDataProviderCreateWithCFData(NSData.dataWithBytes_length_(rgba, len(rgba)))
    return Quartz.CGImageCreate(
        width,
        height,
        8,
        32,
        width * 4,
        Quartz.CGColorSpaceCreateDeviceRGB(),
        Quartz.kCGImageAlphaNoneSkipLast,
        provider,
        None,
        False,
        Quartz.kCGRenderingIntentDefault,
    )


def vision_detect(frame: np.ndarray) -> tuple[list[dict], dict | None]:
    """Upper-body boxes and the attention saliency box of one RGB frame (Apple Vision)."""
    import objc
    import Vision

    with objc.autorelease_pool():
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            _cgimage(frame), None
        )
        bodies_req = Vision.VNDetectHumanRectanglesRequest.alloc().init()
        saliency_req = Vision.VNGenerateAttentionBasedSaliencyImageRequest.alloc().init()
        ok, err = handler.performRequests_error_([bodies_req, saliency_req], None)
        if not ok:
            raise _tool.ToolError("VISION_FAILED", f"Apple Vision request failed: {err}")

        def rect(obs) -> dict:
            r = obs.boundingBox()
            return from_vision_rect(
                r.origin.x, r.origin.y, r.size.width, r.size.height, float(obs.confidence())
            )

        bodies = sorted((rect(o) for o in (bodies_req.results() or [])), key=lambda b: -b["score"])
        saliency = None
        objects = [
            rect(s) for o in (saliency_req.results() or []) for s in (o.salientObjects() or [])
        ]
        if objects:
            x0 = min(b["x"] for b in objects)
            y0 = min(b["y"] for b in objects)
            x1 = max(b["x"] + b["w"] for b in objects)
            y1 = max(b["y"] + b["h"] for b in objects)
            score = max(b["score"] for b in objects)
            saliency = clamp_box({"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "score": score})
    return bodies, saliency


# ---- parallel detection ----


def ordered_map[T, R](fn: Callable[[T], R], items: Iterable[T], workers: int) -> Iterator[R]:
    """`map(fn, items)` on `workers` threads, in order, with at most 2 × workers items in flight
    (frames are large: the source is never read ahead further than that). One worker runs inline."""
    for (result,) in ordered_run(items, [(fn, workers)]):
        yield result


def ordered_run[T](
    items: Iterable[T], stages: Sequence[tuple[Callable[[T], Any], int]]
) -> Iterator[tuple[Any, ...]]:
    """For each item, the results of every `(fn, workers)` stage as a tuple, in item order. Each
    stage has its own pool of `workers` threads, so the stages of one item run at the same time.
    At most 2 × the largest pool items are in flight (frames are large: the source is never read
    ahead further than that). When every stage has one worker, the stages run inline, in order."""
    if all(workers <= 1 for _, workers in stages):
        for item in items:
            yield tuple(fn(item) for fn, _ in stages)
        return
    limit = 2 * max(workers for _, workers in stages)
    with ExitStack() as stack:
        pools = [
            stack.enter_context(
                ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="facetrack")
            )
            for _, workers in stages
        ]
        pending: deque[list[Future[Any]]] = deque()

        def take() -> tuple[Any, ...]:
            return tuple(f.result() for f in pending.popleft())

        try:
            for item in items:
                pending.append([pool.submit(fn, item) for pool, (fn, _) in zip(pools, stages)])
                if len(pending) >= limit:
                    yield take()
            while pending:
                yield take()
        finally:
            for futures in pending:
                for f in futures:
                    f.cancel()


class Detector:
    """Faces + Vision for one frame, safe to call from several threads (a FaceDetector each)."""

    def __init__(self, model_path: Path, min_score: float):
        self.model_path = model_path
        self.min_score = min_score
        self._local = threading.local()
        self._finders: list[FaceFinder] = []
        self._lock = threading.Lock()

    def _finder(self) -> FaceFinder:
        finder = getattr(self._local, "finder", None)
        if finder is None:
            finder = FaceFinder(self.model_path, self.min_score)
            self._local.finder = finder
            with self._lock:
                self._finders.append(finder)
        return finder

    def faces(self, frame: np.ndarray) -> list[dict]:
        return self._finder().find(frame)

    def close(self) -> None:
        with self._lock:
            for f in self._finders:
                f.close()
            self._finders.clear()


# ---- video ----


def probe(path: Path, ffprobe: str, formats: str) -> tuple[int, int, int]:
    """Display width, height (rotation applied) and duration in ms of the first video stream."""
    out = _tool.run_capture(
        [
            ffprobe,
            "-v",
            "error",
            *_tool.media_input_args(path, formats),
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:stream_side_data=rotation:format=duration",
            "-of",
            "json",
        ],
        "ffprobe",
    )
    info = json.loads(out or b"{}")
    streams = info.get("streams") or []
    if not streams or not streams[0].get("width") or not streams[0].get("height"):
        raise _tool.ToolError("MEDIA_UNREADABLE", f"no video stream in {path}")
    stream = streams[0]
    width, height = int(stream["width"]), int(stream["height"])
    rotation = 0
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            rotation = int(side["rotation"])
    if rotation % 180:
        width, height = height, width
    try:
        duration = float((info.get("format") or {}).get("duration") or 0.0)
    except ValueError:  # "N/A"
        duration = 0.0
    return width, height, max(0, round(duration * 1000))


def frames(path: Path, ffmpeg: str, formats: str, fps: float, width: int, height: int):
    """Yield RGB frames (height × width × 3) sampled at `fps` (ffmpeg `fps` filter)."""
    argv = [
        ffmpeg,
        "-nostdin",
        "-v",
        "error",
        *_tool.media_input_args(path, formats),
        "-map",
        "0:v:0",
        "-vf",
        f"fps={fps},scale={width}:{height}:flags=area",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    size = width * height * 3
    with tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=err)
        except FileNotFoundError as exc:
            raise _tool.ToolError("TOOL_MISSING", f"{ffmpeg} not found") from exc
        buf = b""
        try:
            while True:
                buf = proc.stdout.read(size)
                if len(buf) < size:
                    break
                yield np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 3)
        finally:
            proc.stdout.close()
            if proc.poll() is None and len(buf) == size:
                proc.kill()  # the consumer stopped early: do not leave ffmpeg running
            code = proc.wait()
        if code != 0:
            err.seek(0)
            tail = "\n".join(err.read().decode("utf-8", "replace").strip().splitlines()[-10:])
            raise _tool.ToolError("MEDIA_UNREADABLE", f"ffmpeg frame decode failed: {tail}")


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    fps = _tool.number_in(req, "sampleFps", DEFAULT_SAMPLE_FPS, 0.0, 60.0001)
    short_side = _tool.int_at_least(req, "shortSide", DEFAULT_SHORT_SIDE, 64, 1080)
    min_score = _tool.number_in(req, "minFaceScore", DEFAULT_MIN_FACE_SCORE, 0.0, 1.0)
    video = _tool.existing_file(req["videoPath"])
    model_path = Path(req["faceModelPath"])
    check_face_model(model_path)
    formats = req.get("formatWhitelist", _tool.DEFAULT_FORMAT_WHITELIST)
    ffmpeg = req.get("ffmpeg", "ffmpeg")

    src_w, src_h, duration_ms = probe(video, req.get("ffprobe", "ffprobe"), formats)
    width, height = scaled_size(src_w, src_h, short_side)
    expected = max(1, round(duration_ms / 1000 * fps))
    detect = Detector(model_path, min_score)
    samples = []
    step = max(1, expected // 50)
    source = frames(video, ffmpeg, formats, fps, width, height)
    rest: Iterator[tuple[Any, ...]] = iter(())
    results: Iterator[tuple[Any, ...]] = iter(())
    try:
        # The first frame runs on this thread: PyObjC loads the Quartz/Vision names lazily, and that
        # first lookup is not thread-safe.
        first = next(source, None)
        if first is not None:
            head = (vision_detect(first), detect.faces(first))
            # Vision then faces of each frame; one face worker runs everything on this thread.
            workers = (VISION_WORKERS, WORKERS) if WORKERS > 1 else (1, 1)
            rest = ordered_run(source, list(zip((vision_detect, detect.faces), workers)))
            results = itertools.chain([head], rest)
        for i, ((bodies, saliency), faces) in enumerate(results):
            samples.append(
                {
                    "atMs": round(i * 1000 / fps),
                    "faces": faces,
                    "bodies": bodies,
                    "saliency": saliency,
                }
            )
            if i % step == 0:
                _tool.progress(min(i / expected, 0.99), f"frame {i + 1} of about {expected}")
    finally:
        close = getattr(rest, "close", None)
        if close:
            close()
        source.close()
        detect.close()
    if not samples:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"no video frames decoded from {video}")
    # Some containers (e.g. WebM) report no duration: fall back to the sampled span.
    duration_ms = max(duration_ms, round(len(samples) * 1000 / fps))
    _tool.progress(1.0, "done")
    return {
        "sampleFps": fps if fps != int(fps) else int(fps),
        "width": width,
        "height": height,
        "durationMs": duration_ms,
        "faceModel": {"name": FACE_MODEL_NAME, "sha256": FACE_MODEL_SHA256},
        "samples": samples,
    }


if __name__ == "__main__":
    _tool.main(handle)
