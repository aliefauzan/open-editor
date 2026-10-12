"""Captions behind the subject (styles spec Part B caption presets `behindSubject`, plan phase 15
GATE 8 round 3).

Run as `python -I -m vox_py.behind`. Request: `{ captioned, plain, output, beats, mode?, encoder,
cacheDir?, matteShortSide?, ffmpeg?, ffprobe? }`:
- `captioned` and `plain`: the same render with and without burned-in captions (same size, rate
  and length);
- `beats`: `{ startMs, endMs }[]`, the caption chunks (times in the render);
- `mode`: `auto` (default) picks the beats where the foreground subject covers part of the caption
  but not most of it; `all` takes every beat the subject touches;
- `encoder`: `{ codec: "libx264", crf }` or `{ codec: "h264_videotoolbox", bitrate: "<n>k" }`.

Beat choice: at the middle of each beat, the caption pixels are where the two renders differ, and
the subject is the Apple Vision foreground mask of the plain frame. A beat goes behind when the
subject covers 8-65 % of the caption pixels.

Composite: every frame of the captioned render is copied, except inside a chosen beat, where the
plain render's subject pixels (the soft Vision matte) go over the captions:
`out = captioned * (1 - matte) + plain * matte`. The matte is computed at `matteShortSide` (default
540) and scaled up; mattes are cached by the content hash of the small plain frame in `cacheDir`,
so a render again of the same footage reuses them. Needs macOS 14+ (Vision); elsewhere the tool fails
with `TOOL_MISSING` and the engine keeps the plain captioned render.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path

import numpy as np

from . import _tool

REQUEST: _tool.Spec = {
    "captioned": (str, True),
    "plain": (str, True),
    "output": (str, True),
    "beats": (list, True),
    "mode": (str, False),
    "encoder": (dict, True),
    "cacheDir": (str, False),
    "matteShortSide": (int, False),
    "ffmpeg": (str, False),
    "ffprobe": (str, False),
}

FORMATS = "mov,mp4,m4a,3gp,3g2,mj2"
MAX_BEATS = 2000
# a caption pixel: the two renders differ by more than this in some channel (0..255)
DIFF = 40
# share of the caption pixels the subject must cover for a beat to go behind (auto mode)
COVER = (0.08, 0.65)
MIN_CAPTION_PX = 50


def check_beats(raw: list) -> list[tuple[int, int]]:
    if len(raw) > MAX_BEATS:
        raise _tool.ToolError("INVALID_REQUEST", f"beats has more than {MAX_BEATS} items")
    out = []
    for i, b in enumerate(raw):
        s, e = (b.get("startMs"), b.get("endMs")) if isinstance(b, dict) else (None, None)
        ok = all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (s, e))
        if not ok or e <= s:
            raise _tool.ToolError("INVALID_REQUEST", f"beats[{i}] needs integer startMs < endMs")
        out.append((s, e))
    return out


def check_encoder(raw: dict) -> list[str]:
    codec = raw.get("codec")
    if codec == "libx264":
        crf = raw.get("crf", 18)
        if not isinstance(crf, int) or isinstance(crf, bool) or not 0 <= crf <= 51:
            raise _tool.ToolError("INVALID_REQUEST", "encoder.crf must be an integer 0..51")
        return ["-c:v", "libx264", "-crf", str(crf), "-preset", "medium"]
    if codec == "h264_videotoolbox":
        rate = raw.get("bitrate")
        if not isinstance(rate, str) or not rate[:-1].isdigit() or not rate.endswith("k"):
            raise _tool.ToolError("INVALID_REQUEST", "encoder.bitrate must look like 5600k")
        return ["-c:v", "h264_videotoolbox", "-b:v", rate]
    raise _tool.ToolError("INVALID_REQUEST", "encoder.codec must be libx264 or h264_videotoolbox")


def stream_info(path: Path, ffprobe: str) -> dict:
    out = _tool.run_capture(
        [
            ffprobe,
            "-v",
            "error",
            *_tool.media_input_args(path, FORMATS),
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate,color_space",
            "-of",
            "json",
        ],
        "ffprobe",
    )
    streams = json.loads(out or b"{}").get("streams") or []
    if not streams:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"no video stream in {path.name}")
    st = streams[0]
    num, _, den = str(st.get("r_frame_rate", "30/1")).partition("/")
    try:
        rate = (int(num), int(den or 1))
    except ValueError:
        rate = (30, 1)
    if rate[0] <= 0 or rate[1] <= 0:
        rate = (30, 1)
    return {
        "w": int(st["width"]),
        "h": int(st["height"]),
        "rate": rate,
        "matrix": "bt709" if st.get("color_space") == "bt709" else "bt601",
    }


def decoder(ffmpeg: str, path: Path, matrix: str) -> subprocess.Popen:
    return subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            *_tool.media_input_args(path, FORMATS),
            "-map",
            "0:v:0",
            "-vf",
            f"scale=in_color_matrix={matrix}:flags=bicubic",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def frame_at(ffmpeg: str, path: Path, at_ms: int, w: int, h: int, matrix: str) -> np.ndarray | None:
    proc = subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-ss",
            f"{at_ms / 1000:.3f}",
            *_tool.media_input_args(path, FORMATS),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            f"scale={w}:{h}:in_color_matrix={matrix}:flags=area",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or len(proc.stdout) < w * h * 3:
        return None
    return np.frombuffer(proc.stdout[: w * h * 3], dtype=np.uint8).reshape(h, w, 3)


def small_size(w: int, h: int, short: int) -> tuple[int, int]:
    k = min(1.0, short / min(w, h))
    return max(2, int(round(w * k / 2)) * 2), max(2, int(round(h * k / 2)) * 2)


def resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.fromarray(img).resize((w, h), Image.BILINEAR))


class Mattes:
    """Vision subject mattes of small plain frames, cached on disk by content hash."""

    def __init__(self, cache: Path | None):
        from .cutout import vision_alpha

        self.alpha = vision_alpha
        self.cache = cache
        self.hits = 0
        self.computed = 0
        self.seconds = 0.0
        if cache:
            cache.mkdir(parents=True, exist_ok=True)

    def of(self, small: np.ndarray) -> np.ndarray:
        from PIL import Image

        key = hashlib.blake2b(small.tobytes(), digest_size=16).hexdigest()
        file = self.cache / f"{key}.png" if self.cache else None
        if file and file.is_file():
            try:
                with Image.open(file) as im:
                    got = np.asarray(im.convert("L"))
                if got.shape == small.shape[:2]:
                    self.hits += 1
                    return got
            except OSError:
                pass
        t = time.monotonic()
        a = self.alpha(small)
        self.seconds += time.monotonic() - t
        self.computed += 1
        if a is None:
            a = np.zeros(small.shape[:2], dtype=np.uint8)
        if file:
            tmp = file.with_suffix(".tmp.png")
            Image.fromarray(a).save(tmp)
            tmp.replace(file)
        return a


def choose(
    beats: list[tuple[int, int]],
    mode: str,
    captioned: Path,
    plain: Path,
    ffmpeg: str,
    info: dict,
    small: tuple[int, int],
    mattes: Mattes,
) -> list[dict]:
    out = []
    sw, sh = small
    for i, (s, e) in enumerate(beats):
        _tool.progress(0.3 * (i + 1) / max(1, len(beats)), f"caption beats {i + 1} of {len(beats)}")
        mid = (s + e) // 2
        a = frame_at(ffmpeg, captioned, mid, sw, sh, info["matrix"])
        b = frame_at(ffmpeg, plain, mid, sw, sh, info["matrix"])
        entry = {"startMs": s, "endMs": e, "overlap": 0.0, "behind": False}
        if a is None or b is None:
            out.append(entry)
            continue
        cap = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=-1) > DIFF
        n = int(cap.sum())
        if n < MIN_CAPTION_PX:
            out.append(entry)
            continue
        subj = mattes.of(b) > 127
        overlap = float((cap & subj).sum()) / n
        entry["overlap"] = round(overlap, 3)
        entry["behind"] = (
            COVER[0] <= overlap <= COVER[1] if mode == "auto" else overlap > 0.0
        )
        out.append(entry)
    return out


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    captioned = _tool.existing_file(req["captioned"])
    plain = _tool.existing_file(req["plain"])
    output = Path(req["output"])
    if output.suffix.lower() != ".mp4" or not output.parent.is_dir():
        raise _tool.ToolError("INVALID_REQUEST", "output must be an .mp4 path in an existing folder")
    beats = check_beats(req["beats"])
    mode = req.get("mode", "auto")
    if mode not in ("auto", "all"):
        raise _tool.ToolError("INVALID_REQUEST", "mode must be auto or all")
    enc = check_encoder(req["encoder"])
    cache = Path(req["cacheDir"]) if req.get("cacheDir") else None
    short = _tool.int_at_least(req, "matteShortSide", 540, 128, 1080)
    ffmpeg = req.get("ffmpeg", "ffmpeg")
    ffprobe = req.get("ffprobe", "ffprobe")

    from .cutout import vision_available

    if not vision_available():
        raise _tool.ToolError("TOOL_MISSING", "captions behind the subject need Apple Vision (macOS 14+)")

    info = stream_info(captioned, ffprobe)
    other = stream_info(plain, ffprobe)
    if (other["w"], other["h"]) != (info["w"], info["h"]):
        raise _tool.ToolError("INVALID_REQUEST", "captioned and plain renders differ in size")
    w, h = info["w"], info["h"]
    small = small_size(w, h, short)
    mattes = Mattes(cache)
    chosen = choose(beats, mode, captioned, plain, ffmpeg, info, small, mattes)
    ranges = [(c["startMs"], c["endMs"]) for c in chosen if c["behind"]]

    num, den = info["rate"]
    size = w * h * 3
    dec_a = decoder(ffmpeg, captioned, info["matrix"])
    dec_b = decoder(ffmpeg, plain, info["matrix"])
    enc_proc = subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{w}x{h}",
            "-r",
            f"{num}/{den}",
            "-i",
            "pipe:0",
            "-vf",
            f"scale=out_color_matrix={info['matrix']}:flags=bicubic,format=yuv420p",
            *enc,
            *(
                ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
                if info["matrix"] == "bt709"
                else []
            ),
            "-movflags",
            "+faststart",
            f"file:{output}",
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    frames = composited = 0
    try:
        while True:
            a = dec_a.stdout.read(size)
            if len(a) < size:
                break
            b = dec_b.stdout.read(size)
            t = frames * 1000 * den / num
            if len(b) == size and any(s <= t < e for s, e in ranges):
                fa = np.frombuffer(a, dtype=np.uint8).reshape(h, w, 3)
                fb = np.frombuffer(b, dtype=np.uint8).reshape(h, w, 3)
                m = mattes.of(resize(fb, *small))
                k = resize(m, w, h).astype(np.float32)[..., None] / 255.0
                out = fa.astype(np.float32) * (1.0 - k) + fb.astype(np.float32) * k
                a = (out + 0.5).astype(np.uint8).tobytes()
                composited += 1
            enc_proc.stdin.write(a)
            frames += 1
            if frames % 30 == 0:
                _tool.progress(0.3 + 0.69 * min(1.0, composited / max(1, frames)), f"frame {frames}")
    finally:
        enc_proc.stdin.close()
        for p in (dec_a, dec_b):
            p.stdout.close()
            p.wait()
        code = enc_proc.wait()
        err = enc_proc.stderr.read().decode("utf-8", "replace") if enc_proc.stderr else ""
    if code != 0 or frames == 0:
        tail = "\n".join(err.strip().splitlines()[-5:])
        raise _tool.ToolError("MEDIA_UNREADABLE", f"composite failed ({frames} frames): {tail}")
    return {
        "frames": frames,
        "composited": composited,
        "beats": chosen,
        "behind": len(ranges),
        "mattes": {
            "computed": mattes.computed,
            "cached": mattes.hits,
            "msPerMatte": round(1000 * mattes.seconds / mattes.computed, 1) if mattes.computed else 0,
        },
    }


if __name__ == "__main__":
    _tool.main(handle)
