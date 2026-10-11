"""Local video prep: turn a video into a short text card plus two small images, so an agent can
study it without reading raw frames (a frame read costs about 1.5K tokens; this card about 2-3K
for the whole video).

    uv run --project py python scripts/vidprep.py <video-or-url> [...] [--out DIR] [--no-ocr]
        [--no-transcribe] [--language en] [--max-frames 16] [--scene 0.3] [--force]

Everything runs on this Mac, nothing is uploaded:
- ffprobe: duration, size, fps. ffmpeg scene filter: the cut times.
- sheet.jpg: one frame from the middle of each shot (at most --max-frames), with timestamps.
- hook.jpg: four frames from the first 2 seconds.
- Apple Vision (VNRecognizeTextRequest): text on screen, de-duplicated, first time seen.
- vox_py.transcribe (Silero VAD, then mlx-whisper): words, words per minute, opening line.
- vox_py.audioqa_dsp: integrated loudness (BS.1770-4, LUFS).

Output goes to <video dir>/<stem>.prep/ (or --out DIR for one input, or --out DIR/<stem>/ for
several): summary.md (read this first), summary.json, sheet.jpg, hook.jpg, transcript.txt. A URL
is downloaded with yt-dlp into ./vidprep/<id>/ first. Existing output is reused unless --force.
Exit code 0 when every input was prepared.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from vox_py import _tool

SHEET_MAX_EDGE = 1568  # longest edge an image keeps before the model downscales it
SHEET_MAX_PIXELS = 1_150_000
HOOK_MAX_PIXELS = 600_000
HOOK_TIMES_S = (0.0, 0.5, 1.0, 1.5)
OCR_MIN_CONFIDENCE = 0.5
OCR_MAX_LINES = 40
OPENING_MAX_WORDS = 20
TRANSCRIPT_GAP_MS = 700
TRANSCRIPT_LINE_WORDS = 14
RAW_FRAME_EVERY_S = 2.0  # the baseline: reading one full frame every 2 s
MIN_FRAMES = 6
PAD_EVERY_S = (
    6.0  # few cuts (one long take): still one sheet frame per 6 s, up to --max-frames
)


# ---- pure helpers (unit tested) ----


def image_tokens(width: int, height: int) -> int:
    """Rough Claude image cost: pixels / 750 after the 1568 px edge and 1.15 MP caps."""
    scale = min(1.0, SHEET_MAX_EDGE / max(width, height))
    w, h = width * scale, height * scale
    if w * h > SHEET_MAX_PIXELS:
        s = math.sqrt(SHEET_MAX_PIXELS / (w * h))
        w, h = w * s, h * s
    return max(1, round(w * h / 750))


def text_tokens(text: str) -> int:
    return max(1, round(len(text) / 4))


def parse_scene_times(showinfo_stderr: str) -> list[float]:
    """Cut times (s) from ffmpeg `showinfo` lines after a `select='gt(scene,X)'` filter."""
    times = [float(m) for m in re.findall(r"pts_time:\s*([0-9.]+)", showinfo_stderr)]
    return sorted({round(t, 3) for t in times})


def pick_frame_times(
    cuts: list[float], duration: float, max_frames: int, min_frames: int = MIN_FRAMES
) -> list[float]:
    """One time per shot (its midpoint), thinned evenly to `max_frames`, padded to `min_frames`."""
    if duration <= 0:
        return [0.0]
    edges = [0.0] + [c for c in cuts if 0.0 < c < duration] + [duration]
    mids = [(a + b) / 2 for a, b in itertools.pairwise(edges) if b - a > 0.05]
    n = max(min_frames, min(max_frames, math.ceil(duration / PAD_EVERY_S)))
    if len(mids) < n:
        even = [duration * (i + 0.5) / n for i in range(n)]
        gap = duration / (n * 2)
        mids += [t for t in even if all(abs(t - m) >= gap for m in mids)]
        mids.sort()
    if len(mids) > max_frames:
        step = (len(mids) - 1) / (max_frames - 1) if max_frames > 1 else 0
        mids = [mids[round(i * step)] for i in range(max_frames)]
    return [round(t, 3) for t in mids]


def grid_shape(n: int, frame_w: int, frame_h: int) -> tuple[int, int]:
    """Columns and rows that make the sheet closest to square."""
    cols = max(1, min(n, round(math.sqrt(n * frame_h / max(frame_w, 1)))))
    return cols, math.ceil(n / cols)


def fit_thumb(
    cols: int, rows: int, frame_w: int, frame_h: int, max_edge: int, max_pixels: int
) -> tuple[int, int]:
    """Thumb size so the whole grid stays under the edge and pixel caps."""
    s = min(1.0, max_edge / (cols * frame_w), max_edge / (rows * frame_h))
    area = cols * frame_w * rows * frame_h * s * s
    if area > max_pixels:
        s *= math.sqrt(max_pixels / area)
    return max(16, int(frame_w * s)), max(16, int(frame_h * s))


def _norm(text: str) -> str:
    return re.sub(r"[^0-9a-z]+", "", text.lower())


def dedupe_ocr(
    frames: list[tuple[float, list[tuple[str, float]]]], spoken: set[str] | None = None
) -> list[dict]:
    """On-screen lines across frames: confident, de-duplicated, with the first time seen.

    A one-word line is dropped when it is short (under 4 letters or digits) or is a word from the
    transcript (`spoken`, normalised): that is a burned-in caption, already in the transcript.
    """
    spoken = spoken or set()
    seen: set[str] = set()
    out: list[dict] = []
    for t, lines in frames:
        for text, conf in lines:
            key = _norm(text)
            one_word = len(text.split()) == 1
            if conf < OCR_MIN_CONFIDENCE or len(key) < 2 or key in seen:
                continue
            if one_word and (len(key) < 4 or key in spoken):
                continue
            seen.add(key)
            out.append({"t": round(t, 2), "text": text.strip()})
    return out[:OCR_MAX_LINES]


def opening_line(words: list[dict]) -> str:
    """Words up to the first sentence end, at most OPENING_MAX_WORDS."""
    out = []
    for w in words[:OPENING_MAX_WORDS]:
        out.append(w["text"])
        if w["text"].endswith((".", "?", "!")):
            break
    return " ".join(out)


def transcript_lines(words: list[dict]) -> list[str]:
    """`[m:ss] text` lines, broken at pauses and every TRANSCRIPT_LINE_WORDS words."""
    lines, cur, start, last_end = [], [], 0, None
    for w in words:
        gap = last_end is not None and w["startMs"] - last_end > TRANSCRIPT_GAP_MS
        if cur and (gap or len(cur) >= TRANSCRIPT_LINE_WORDS):
            lines.append(f"[{clock(start / 1000)}] {' '.join(cur)}")
            cur = []
        if not cur:
            start = w["startMs"]
        cur.append(w["text"])
        last_end = w["endMs"]
    if cur:
        lines.append(f"[{clock(start / 1000)}] {' '.join(cur)}")
    return lines


def clock(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 60}:{s % 60:02d}"


def render_card(s: dict) -> str:
    """summary.md: the text an agent reads instead of the frames."""
    m = s["media"]
    head = [f"duration {clock(m['durationS'])} ({m['durationS']:.1f} s)"]
    head.append(f"{m['width']}x{m['height']} @ {m['fps']:g} fps")
    head.append(f"{len(s['sceneCuts'])} scene cuts")
    if s.get("loudnessLufs") is not None:
        head.append(f"{s['loudnessLufs']:.1f} LUFS")
    lines = [f"# vidprep: {s['name']}", "", " · ".join(head)]
    src = s.get("source") or {}
    if src.get("uploader") or src.get("title"):
        lines.append(
            f"source: {src.get('uploader') or '?'} · {src.get('title') or ''}".rstrip()
        )
    if src.get("description"):
        lines.append(f"caption: {src['description']}")
    tr = s.get("transcript")
    if tr is None:
        lines.append("speech: not transcribed")
    elif not tr["words"]:
        lines.append("speech: none found")
    else:
        lines.append(
            f"speech: {tr['words']} words ({tr['wordsPerMinute']}/min) · {tr['language']}"
        )
        lines.append(f'opening line: "{tr["openingLine"]}"')
    if s["sceneCuts"]:
        lines.append("cuts at: " + " ".join(clock(c) for c in s["sceneCuts"][:40]))
    ocr = s.get("onScreenText")
    if ocr is None:
        lines.append("on screen: OCR off")
    elif ocr:
        lines += ["", "on screen (Apple Vision OCR, first seen):"]
        lines += [f"- {clock(o['t'])} {o['text']}" for o in ocr]
    else:
        lines.append("on screen: no text found")
    sheet = s["images"]["sheet"]
    lines += [
        "",
        f"images: sheet.jpg ({len(sheet['times'])} frames, row by row: "
        + " ".join(clock(t) for t in sheet["times"])
        + "), hook.jpg (first 2 s)",
    ]
    if tr and tr["words"]:
        lines.append(
            "full transcript: transcript.txt (open only if the card is not enough)"
        )
    est = s["tokenEstimate"]
    lines.append(
        f"est. read cost: ~{est['prepared']} tokens (card + 2 images) vs ~{est['rawFrames']} for a "
        f"full frame every {RAW_FRAME_EVERY_S:g} s"
    )
    return "\n".join(lines) + "\n"


# ---- media steps ----


def probe(path: Path) -> dict:
    argv = [
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
        "-format_whitelist", _tool.DEFAULT_FORMAT_WHITELIST,
        "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate",
        "-of", "json", f"file:{path}",
    ]  # fmt: skip
    info = json.loads(_tool.run_capture(argv, "ffprobe"))
    video = next(
        (s for s in info.get("streams", []) if s.get("codec_type") == "video"), None
    )
    if video is None:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"no video stream in {path}")
    num, _, den = (video.get("avg_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    return {
        "durationS": float(info.get("format", {}).get("duration") or 0.0),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": round(fps, 3),
        "hasAudio": any(
            s.get("codec_type") == "audio" for s in info.get("streams", [])
        ),
    }


def scene_cuts(path: Path, threshold: float) -> list[float]:
    argv = [
        "ffmpeg", "-nostdin", "-hide_banner", "-v", "info",
        *_tool.media_input_args(path, _tool.DEFAULT_FORMAT_WHITELIST),
        "-an", "-vf", f"scale=160:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-",
    ]  # fmt: skip
    proc = subprocess.run(argv, capture_output=True, check=False)
    if proc.returncode != 0:
        raise _tool.ToolError("MEDIA_UNREADABLE", "ffmpeg scene detection failed")
    return parse_scene_times(proc.stderr.decode("utf-8", "replace"))


def grab_frame(path: Path, t: float, dest: Path, long_edge: int = 1280) -> Path:
    scale = f"scale='if(gt(iw,ih),min({long_edge},iw),-2)':'if(gt(iw,ih),-2,min({long_edge},ih))'"
    argv = [
        "ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{t:.3f}",
        *_tool.media_input_args(path, _tool.DEFAULT_FORMAT_WHITELIST),
        "-frames:v", "1", "-vf", scale, "-q:v", "3", str(dest),
    ]  # fmt: skip
    _tool.run_capture(argv, f"ffmpeg frame at {t:.2f} s")
    if not dest.is_file():  # -ss past the last frame writes nothing
        raise _tool.ToolError("MEDIA_UNREADABLE", f"no frame at {t:.2f} s")
    return dest


def build_grid(
    frames: list[Path], labels: list[str], cols: int, rows: int, max_pixels: int
):
    from PIL import Image, ImageDraw, ImageFont

    first = Image.open(frames[0])
    tw, th = fit_thumb(
        cols, rows, first.width, first.height, SHEET_MAX_EDGE, max_pixels
    )
    sheet = Image.new("RGB", (cols * tw, rows * th), "black")
    font = ImageFont.load_default(size=max(12, th // 14))
    draw = ImageDraw.Draw(sheet)
    for i, (f, label) in enumerate(zip(frames, labels)):
        x, y = (i % cols) * tw, (i // cols) * th
        sheet.paste(Image.open(f).convert("RGB").resize((tw, th)), (x, y))
        box = draw.textbbox((x + 4, y + 4), label, font=font)
        draw.rectangle((box[0] - 3, box[1] - 2, box[2] + 3, box[3] + 2), fill="black")
        draw.text((x + 4, y + 4), label, fill="yellow", font=font)
    return sheet


def ocr_lines(image: Path) -> list[tuple[str, float]]:
    """Apple Vision accurate text recognition; lines top to bottom."""
    import objc
    import Quartz
    import Vision
    from Foundation import NSURL

    with objc.autorelease_pool():
        src = Quartz.CGImageSourceCreateWithURL(
            NSURL.fileURLWithPath_(str(image)), None
        )
        cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None) if src else None
        if cg is None:
            return []
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            cg, None
        )
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        req.setUsesLanguageCorrection_(True)
        ok, err = handler.performRequests_error_([req], None)
        if not ok:
            raise _tool.ToolError(
                "VISION_FAILED", f"Apple Vision text request failed: {err}"
            )
        found = []
        for obs in req.results() or []:
            cands = obs.topCandidates_(1)
            if cands:
                found.append(
                    (
                        -obs.boundingBox().origin.y,
                        str(cands[0].string()),
                        float(cands[0].confidence()),
                    )
                )
        return [(text, conf) for _, text, conf in sorted(found)]


def transcribe(path: Path, language: str | None) -> dict:
    from vox_py import transcribe as tr

    req: dict = {"audioPath": str(path)}
    if language:
        req["language"] = language
    return tr.handle(req)


def loudness(path: Path) -> float | None:
    from vox_py import audioqa_dsp

    lufs = audioqa_dsp.integrated_lufs(
        audioqa_dsp.decode(path, "ffmpeg", _tool.DEFAULT_FORMAT_WHITELIST)
    )
    return round(lufs, 1) if lufs is not None else None


def download(url: str, root: Path) -> tuple[Path, dict]:
    if shutil.which("yt-dlp") is None:
        raise _tool.ToolError("TOOL_MISSING", "yt-dlp not found (needed for URLs)")
    tmp = root / "_download"
    tmp.mkdir(parents=True, exist_ok=True)
    argv = [
        "yt-dlp", "--no-warnings", "--no-playlist", "--write-info-json",
        "-f", "bv*[height<=1920]+ba/b", "--merge-output-format", "mp4",
        "-o", str(tmp / "%(id)s.%(ext)s"), url,
    ]  # fmt: skip
    _tool.run_capture(argv, "yt-dlp download")
    videos = sorted(
        p for p in tmp.iterdir() if p.suffix in (".mp4", ".mkv", ".webm", ".mov")
    )
    if not videos:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"yt-dlp produced no video for {url}")
    video = videos[-1]
    dest_dir = root / re.sub(r"[^A-Za-z0-9_-]+", "_", video.stem)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"source{video.suffix}"
    video.replace(dest)
    info: dict = {}
    meta = tmp / f"{video.stem}.info.json"
    if meta.is_file():
        raw = json.loads(meta.read_text())
        info = {
            "url": url,
            "uploader": raw.get("uploader") or raw.get("channel"),
            "title": raw.get("title"),
            "description": (raw.get("description") or "")[:400],
        }
        meta.replace(dest_dir / "source.info.json")
    shutil.rmtree(tmp, ignore_errors=True)
    return dest, info


# ---- one video ----


def prepare(
    path: Path, out: Path, args: argparse.Namespace, source: dict | None = None
) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    media = probe(path)
    dur = media["durationS"]
    cuts = scene_cuts(path, args.scene)
    times = pick_frame_times(cuts, dur, args.max_frames)
    last = max(0.0, dur - 0.1)
    hook_times = [min(t, last) for t in HOOK_TIMES_S if t < max(dur, 0.1)]

    with tempfile.TemporaryDirectory(prefix="vidprep-") as tmpdir:
        tmp = Path(tmpdir)
        sheet_frames = [
            grab_frame(path, min(t, last), tmp / f"s{i:03d}.jpg")
            for i, t in enumerate(times)
        ]
        hook_frames = [
            grab_frame(path, t, tmp / f"h{i}.jpg", 640)
            for i, t in enumerate(hook_times)
        ]
        cols, rows = grid_shape(len(sheet_frames), media["width"], media["height"])
        sheet = build_grid(
            sheet_frames, [clock(t) for t in times], cols, rows, SHEET_MAX_PIXELS
        )
        sheet.save(out / "sheet.jpg", quality=82)
        hook = build_grid(
            hook_frames,
            [f"{t:.1f}s" for t in hook_times],
            len(hook_frames),
            1,
            HOOK_MAX_PIXELS,
        )
        hook.save(out / "hook.jpg", quality=82)
        raw_ocr = (
            None
            if args.no_ocr
            else [(t, ocr_lines(f)) for t, f in zip(times, sheet_frames)]
        )

    summary: dict = {
        "name": path.name if not source else (source.get("url") or path.name),
        "media": media,
        "sceneCuts": cuts,
        "loudnessLufs": loudness(path) if media["hasAudio"] else None,
        "onScreenText": None,
        "images": {
            "sheet": {"file": "sheet.jpg", "cols": cols, "rows": rows, "times": times,
                      "size": list(sheet.size)},
            "hook": {"file": "hook.jpg", "times": hook_times, "size": list(hook.size)},
        },
    }  # fmt: skip
    if source:
        summary["source"] = source
    summary["transcript"] = None
    words: list[dict] = []
    if media["hasAudio"] and not args.no_transcribe:
        res = transcribe(path, args.language)
        words = res["words"]
        (out / "transcript.txt").write_text("\n".join(transcript_lines(words)) + "\n")
        summary["transcript"] = {
            "language": res["language"],
            "words": len(words),
            "wordsPerMinute": round(len(words) / (dur / 60)) if dur > 0 else 0,
            "openingLine": opening_line(words),
            "file": "transcript.txt",
        }
    elif not media["hasAudio"]:
        summary["transcript"] = {"language": "und", "words": 0, "wordsPerMinute": 0,
                                 "openingLine": "", "file": None}  # fmt: skip
    if raw_ocr is not None:
        summary["onScreenText"] = dedupe_ocr(raw_ocr, {_norm(w["text"]) for w in words})

    raw_frames = max(1, math.ceil(dur / RAW_FRAME_EVERY_S))
    summary["tokenEstimate"] = {
        "prepared": 0,
        "rawFrames": raw_frames * image_tokens(media["width"], media["height"]),
    }
    for _ in range(
        2
    ):  # the card prints the estimate, so settle it on the card's own length
        card = render_card(summary)
        summary["tokenEstimate"]["prepared"] = (
            text_tokens(card) + image_tokens(*sheet.size) + image_tokens(*hook.size)
        )
    (out / "summary.md").write_text(render_card(summary))
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def out_dir_for(path: Path, args: argparse.Namespace, many: bool) -> Path:
    if args.out:
        return Path(args.out) / path.stem if many else Path(args.out)
    return path.parent / f"{path.stem}.prep"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Prepare videos for cheap agent reading.")
    ap.add_argument("inputs", nargs="+", help="video files or URLs")
    ap.add_argument(
        "--out", help="output folder (one input) or parent folder (several)"
    )
    ap.add_argument(
        "--no-ocr", action="store_true", help="skip Apple Vision text recognition"
    )
    ap.add_argument("--no-transcribe", action="store_true", help="skip Whisper")
    ap.add_argument(
        "--language", help="speech language code, e.g. en (default: detect)"
    )
    ap.add_argument(
        "--max-frames", type=int, default=16, help="frames on sheet.jpg (default 16)"
    )
    ap.add_argument(
        "--scene", type=float, default=0.3, help="ffmpeg scene threshold (default 0.3)"
    )
    ap.add_argument(
        "--force", action="store_true", help="redo inputs that already have output"
    )
    args = ap.parse_args(argv)
    if not 1 <= args.max_frames <= 64 or not 0.0 < args.scene < 1.0:
        ap.error("--max-frames must be 1-64 and --scene in (0, 1)")

    many = len(args.inputs) > 1
    failed = 0
    for item in args.inputs:
        try:
            source = None
            if re.match(r"https?://", item):
                path, source = download(item, Path(args.out or "vidprep"))
                out = path.parent
            else:
                path = _tool.existing_file(item)
                out = out_dir_for(path, args, many)
            if (out / "summary.md").is_file() and not args.force:
                print(f"skip (already prepared): {out / 'summary.md'}")
                continue
            s = prepare(path, out, args, source)
            est = s["tokenEstimate"]
            print(
                f"{out / 'summary.md'}  ~{est['prepared']} tokens (raw ~{est['rawFrames']})"
            )
        except _tool.ToolError as exc:
            failed += 1
            print(f"vidprep: {item}: {exc.code}: {exc.message}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
