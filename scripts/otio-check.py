"""Automated stand-in for the GATE 2 Resolve check (phase 05 step 15; owner has no Resolve).

    uv run --project py python scripts/otio-check.py <timeline.otio> [--out <summary.json>]

Reads the .otio with OpenTimelineIO (the library Resolve's importer is built on), then checks
what the owner would have looked at in Resolve: every clip's media file exists, the layer MOVs
carry alpha, and the timeline has video and audio tracks with clips in them. It cannot prove that
Resolve itself imports the file; the log records the check as "Resolve not tested".
Exit code 0 when every check passes.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

import opentimelineio as otio

ALPHA_PIX_FMTS = ("yuva", "rgba", "argb", "bgra", "abgr", "gbrap", "ya")


def media_path(ref_url: str, base: Path) -> Path:
    u = urlparse(ref_url)
    if u.scheme in ("", "file"):
        p = Path(unquote(u.path if u.scheme else ref_url))
        return p if p.is_absolute() else (base / p)
    raise ValueError(f"not a local file: {ref_url}")


def pix_fmt(path: Path) -> str:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=pix_fmt",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def check(otio_file: Path) -> dict:
    tl = otio.adapters.read_from_file(str(otio_file))
    base = otio_file.parent
    problems: list[str] = []
    tracks = []
    layers = []
    for track in tl.tracks:
        clips = list(track.find_clips())
        tracks.append({"name": track.name, "kind": track.kind, "clips": len(clips)})
        for clip in clips:
            ref = clip.media_reference
            if not isinstance(ref, otio.schema.ExternalReference):
                problems.append(f"{track.name}/{clip.name}: no external media reference")
                continue
            try:
                path = media_path(ref.target_url, base)
            except ValueError as e:
                problems.append(f"{track.name}/{clip.name}: {e}")
                continue
            if not path.is_file():
                problems.append(f"{track.name}/{clip.name}: missing file {path.name}")
                continue
            if path.suffix.lower() == ".mov":
                fmt = pix_fmt(path)
                alpha = fmt.startswith(ALPHA_PIX_FMTS)
                layers.append({"clip": clip.name, "file": path.name, "pixFmt": fmt, "alpha": alpha})
                if not alpha:
                    problems.append(f"{track.name}/{clip.name}: layer {path.name} has no alpha ({fmt})")
    kinds = {t["kind"] for t in tracks if t["clips"] > 0}
    if otio.schema.TrackKind.Video not in kinds:
        problems.append("no video track with clips")
    if otio.schema.TrackKind.Audio not in kinds:
        problems.append("no audio track with clips")
    if not layers:
        problems.append("no layer MOVs referenced")
    return {
        "file": otio_file.name,
        "durationS": round(tl.duration().to_seconds(), 3),
        "tracks": tracks,
        "layers": layers,
        "problems": problems,
        "pass": not problems,
        "note": "Automated stand-in; Resolve itself not tested (owner has no Resolve).",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("otio", type=Path)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    summary = check(a.otio)
    text = json.dumps(summary, indent=2)
    if a.out:
        a.out.write_text(text + "\n")
    print(text)
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
