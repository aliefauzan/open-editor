"""OTIO timeline writer and checker (engine "Stages", `export-timeline`; R5 opentimelineio).

Run as `python -I -m vox_py.timeline`.

Write request: `{ mode?: "write", format?: "otio" | "fcpxml", width?, height? (FCPXML format size), output, name, rate: { num, den }, tracks }`. Each track is
`{ kind: "video" | "audio", name, clips }`; each clip is `{ name, path, startFrame, durationFrames,
sourceFrame, sourceDurationFrames?, mediaRate?: { num, den }, mediaDurationFrames?, timeScalar? }` in frames of `rate` (record side) and
of `mediaRate` (source side, default `rate`). Paths are absolute; clips on a track must not overlap;
gaps are filled. The file is written as OTIO JSON (`format` otio, output `.otio`) or as FCPXML 1.8 through
`otio-fcpx-xml-adapter` (`format` fcpxml, output `.fcpxml`; `mediaDurationFrames` is the whole source
file length in `mediaRate` frames, default: the used part). `timeScalar` (clip speed, plan D-62) adds an
OTIO `LinearTimeWarp` effect; the source range keeps the timeline length, as OTIO expects. Result:
`{ output, tracks, clips }`.

Check request: `{ mode: "check", path }` reads an `.otio` and returns
`{ name, tracks, clips: [{ track, name, targetUrl, exists }] }` (a file URL that names an existing
file counts as resolved).
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlparse

from . import _tool

WRITE: _tool.Spec = {
    "mode": (str, False),
    "format": (str, False),
    "width": (int, False),
    "height": (int, False),
    "output": (str, True),
    "name": (str, True),
    "rate": (dict, True),
    "tracks": (list, True),
}
CHECK: _tool.Spec = {"mode": (str, True), "path": (str, True)}

MAX_CLIPS = 20_000
FORMATS = ("otio", "fcpxml")


def _rate(raw: object, what: str) -> float:
    if not isinstance(raw, dict) or set(raw) != {"num", "den"}:
        raise _tool.ToolError("INVALID_REQUEST", f"{what} must be {{ num, den }}")
    num, den = raw["num"], raw["den"]
    if not all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in (num, den)):
        raise _tool.ToolError("INVALID_REQUEST", f"{what} needs positive integers")
    return num / den


def _int(clip: dict, key: str, lo: int = 0) -> int:
    v = clip.get(key)
    if not isinstance(v, int) or isinstance(v, bool) or v < lo:
        raise _tool.ToolError("INVALID_REQUEST", f"clip field {key} must be an integer ≥ {lo}")
    return v


def _scalar(clip: dict) -> float:
    v = clip.get("timeScalar")
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not 0.25 <= v <= 4:
        raise _tool.ToolError("INVALID_REQUEST", "clip field timeScalar must be a number in 0.25–4")
    return float(v)


def _file_url(path: str) -> str:
    p = Path(path)
    if "\x00" in path or not p.is_absolute():
        raise _tool.ToolError("INVALID_REQUEST", f"clip paths must be absolute: {path}")
    return p.as_uri()


def _write_fcpxml(tl, out: Path, width: object, height: object) -> None:
    """FCPXML 1.8 through otio-fcpx-xml-adapter, then three fixes the adapter leaves open.

    The adapter repeats every asset as a loose `asset-clip` at the document root, writes an empty
    project `uid`, and gives the format no size. Final Cut Pro wants the project inside an event, a
    uid that is absent rather than empty, and a sized format, so those are fixed here.
    """
    import xml.etree.ElementTree as ET

    import opentimelineio as otio

    xml = otio.adapters.write_to_string(tl, adapter_name="fcpx_xml")
    root = ET.fromstring(xml)
    for el in list(root.findall("asset-clip")):
        root.remove(el)
    if isinstance(width, int) and isinstance(height, int) and not isinstance(width, bool):
        for fmt in root.findall("./resources/format"):
            fmt.set("width", str(width))
            fmt.set("height", str(height))
            fmt.set("name", f"Vox {width}x{height}")
    for project in root.findall("project"):
        if project.get("uid") == "":
            del project.attrib["uid"]
        event = ET.Element("event", {"name": project.get("name", "Vox Studio")})
        root.remove(project)
        event.append(project)
        root.append(event)
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    out.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n\n' + body + "\n")


def write(raw: dict) -> dict:
    req = _tool.check_request(raw, WRITE)
    import opentimelineio as otio

    rate = _rate(req["rate"], "rate")
    fmt = req.get("format", "otio")
    if fmt not in FORMATS:
        raise _tool.ToolError("INVALID_REQUEST", "format must be otio or fcpxml")
    out = Path(req["output"])
    if out.suffix != "." + fmt or not out.parent.is_dir():
        raise _tool.ToolError(
            "INVALID_REQUEST", f"output must be a .{fmt} file in an existing folder"
        )
    tl = otio.schema.Timeline(name=req["name"])
    tl.global_start_time = otio.opentime.RationalTime(0, rate)
    n_clips = 0
    for t in req["tracks"]:
        if not isinstance(t, dict) or t.get("kind") not in ("video", "audio"):
            raise _tool.ToolError("INVALID_REQUEST", "track kind must be video or audio")
        kind = otio.schema.TrackKind.Video if t["kind"] == "video" else otio.schema.TrackKind.Audio
        track = otio.schema.Track(name=str(t.get("name", "")), kind=kind)
        clips = t.get("clips")
        if not isinstance(clips, list):
            raise _tool.ToolError("INVALID_REQUEST", "track clips must be a list")
        cursor = 0
        for c in sorted(clips, key=lambda c: c.get("startFrame", 0) if isinstance(c, dict) else 0):
            if not isinstance(c, dict):
                raise _tool.ToolError("INVALID_REQUEST", "clips must be objects")
            n_clips += 1
            if n_clips > MAX_CLIPS:
                raise _tool.ToolError("INVALID_REQUEST", "too many clips")
            start = _int(c, "startFrame")
            dur = _int(c, "durationFrames", 1)
            if start < cursor:
                raise _tool.ToolError("INVALID_REQUEST", "clips on a track overlap")
            if start > cursor:
                track.append(
                    otio.schema.Gap(
                        source_range=otio.opentime.TimeRange(
                            otio.opentime.RationalTime(0, rate),
                            otio.opentime.RationalTime(start - cursor, rate),
                        )
                    )
                )
            m_rate = _rate(c["mediaRate"], "mediaRate") if "mediaRate" in c else rate
            src = _int(c, "sourceFrame")
            src_dur = _int(c, "sourceDurationFrames", 1) if "sourceDurationFrames" in c else dur
            ref = otio.schema.ExternalReference(target_url=_file_url(str(c.get("path", ""))))
            if fmt == "fcpxml":
                # FCPXML assets carry the whole file length; the adapter reads it from here.
                media_dur = (
                    _int(c, "mediaDurationFrames", 1)
                    if "mediaDurationFrames" in c
                    else src + src_dur
                )
                ref.available_range = otio.opentime.TimeRange(
                    otio.opentime.RationalTime(0, m_rate),
                    otio.opentime.RationalTime(max(media_dur, src + src_dur), m_rate),
                )
            clip = otio.schema.Clip(
                name=str(c.get("name", "")),
                media_reference=ref,
                source_range=otio.opentime.TimeRange(
                    otio.opentime.RationalTime(src, m_rate),
                    otio.opentime.RationalTime(src_dur, m_rate),
                ),
            )
            if "timeScalar" in c:
                clip.effects.append(otio.schema.LinearTimeWarp(time_scalar=_scalar(c)))
            track.append(clip)
            cursor = start + dur
        tl.tracks.append(track)
    if fmt == "fcpxml":
        _write_fcpxml(tl, out, req.get("width"), req.get("height"))
    else:
        otio.adapters.write_to_file(tl, str(out), adapter_name="otio_json")
    _tool.progress(1.0, "written")
    return {"output": str(out), "tracks": len(tl.tracks), "clips": n_clips}


def check(raw: dict) -> dict:
    req = _tool.check_request(raw, CHECK)
    path = _tool.existing_file(req["path"])
    import opentimelineio as otio

    try:
        tl = otio.adapters.read_from_file(str(path))
    except Exception as exc:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"cannot read the timeline: {exc}") from exc
    clips = []
    for ti, track in enumerate(tl.tracks):
        for item in track:
            if not isinstance(item, otio.schema.Clip):
                continue
            url = getattr(item.media_reference, "target_url", "") or ""
            u = urlparse(url)
            exists = u.scheme == "file" and Path(unquote(u.path)).is_file()
            clips.append({"track": ti, "name": item.name, "targetUrl": url, "exists": exists})
    return {"name": tl.name, "tracks": len(tl.tracks), "clips": clips}


def handle(raw: dict) -> dict:
    mode = raw.get("mode", "write") if isinstance(raw, dict) else None
    if mode == "check":
        return check(raw)
    if mode == "write":
        return write(raw)
    if isinstance(raw, dict) and mode is not None:
        raise _tool.ToolError("INVALID_REQUEST", "mode must be write or check")
    return write(raw)


if __name__ == "__main__":
    _tool.main(handle)
