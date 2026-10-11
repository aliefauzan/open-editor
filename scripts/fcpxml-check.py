"""Automated stand-in for the FCPXML import check (phase 14g; neither Final Cut Pro nor Resolve installed).

    uv run --project py python scripts/fcpxml-check.py <timeline.fcpxml> [--out summary.json]
        [--dtd FCPXMLv1_8.dtd | --fetch-dtd] [--expect-clips N]

Two checks, then a JSON summary (exit code 0 when both pass):
1. DTD: `xmllint --dtdvalid` against Apple's FCPXML 1.8 DTD. The DTD is Apple's file and is not part
   of this repo: pass `--dtd`, set VOX_FCPXML_DTD, or run once with `--fetch-dtd` to cache a copy in
   ~/.cache/vox-studio/.
2. Structure: every asset file exists, every `ref`/`format` resolves, the spine is gap-free in order
   and ends at the sequence duration, every lane clip sits inside its parent clip, and no clip
   reads past the end of its asset.

It cannot prove that Final Cut Pro or Resolve imports the file; callers record the result as
"not imported in an NLE".
"""

import argparse
import json
import shutil
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from urllib.parse import unquote, urlparse

DTD_URL = (
    "https://raw.githubusercontent.com/CommandPost/CommandPost/develop/src/extensions/cp/apple/"
    "fcpxml/dtd/FCPXMLv1_8.dtd"
)
DTD_CACHE = Path.home() / ".cache" / "vox-studio" / "FCPXMLv1_8.dtd"
CLIPS = ("clip", "asset-clip", "video", "audio", "ref-clip", "gap")


def secs(text: str | None, default: Fraction = Fraction(0)) -> Fraction:
    """`3600s`, `30/1s`, `1001/30000s` -> exact seconds."""
    if text is None:
        return default
    t = text.strip()
    if not t.endswith("s"):
        raise ValueError(f"not a time value: {text}")
    return Fraction(t[:-1])


def dtd_path(arg: str | None, fetch: bool) -> Path | None:
    import os

    for cand in (arg, os.environ.get("VOX_FCPXML_DTD"), str(DTD_CACHE)):
        if cand and Path(cand).is_file():
            return Path(cand)
    if fetch:
        DTD_CACHE.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(DTD_URL, timeout=30) as r:
            DTD_CACHE.write_bytes(r.read())
        return DTD_CACHE
    return None


def dtd_validate(path: Path, dtd: Path) -> list[str]:
    xmllint = shutil.which("xmllint")
    if not xmllint:
        return ["xmllint not found"]
    r = subprocess.run(
        [xmllint, "--noout", "--dtdvalid", str(dtd), str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    return (
        []
        if r.returncode == 0
        else [ln for ln in r.stderr.splitlines() if ln.strip()][:20]
    )


def structure(root: ET.Element) -> tuple[dict, list[str]]:
    problems: list[str] = []
    if root.tag != "fcpxml" or root.get("version") != "1.8":
        problems.append(f"root is {root.tag} {root.get('version')}, want fcpxml 1.8")
    formats = {f.get("id"): f for f in root.findall("./resources/format")}
    assets = {a.get("id"): a for a in root.findall("./resources/asset")}
    for a in assets.values():
        u = urlparse(a.get("src", ""))
        if u.scheme != "file" or not Path(unquote(u.path)).is_file():
            problems.append(f"asset {a.get('name')}: missing file {a.get('src')}")
        if a.get("format") not in formats:
            problems.append(
                f"asset {a.get('name')}: format {a.get('format')} not declared"
            )
    projects = root.findall(".//project")
    if len(projects) != 1:
        problems.append(f"{len(projects)} projects, want 1")
        return {}, problems
    seq = projects[0].find("sequence")
    spine = seq.find("spine") if seq is not None else None
    if seq is None or spine is None:
        problems.append("project has no sequence/spine")
        return {}, problems
    if seq.get("format") not in formats:
        problems.append("sequence format not declared")
    counts = {"video": 0, "audio": 0, "clips": 0}

    def walk(el: ET.Element, where: str) -> None:
        """Count video/audio refs and nested clips under el; every ref must name an asset."""
        for ch in el:
            if ch.tag not in CLIPS:
                continue
            name = f"{where}/{ch.get('name') or ch.tag}"
            if ch.tag in ("video", "audio"):
                counts[ch.tag] += 1
                if ch.get("ref") not in assets:
                    problems.append(f"{name}: ref {ch.get('ref')} not an asset")
            if ch.tag == "clip":
                counts["clips"] += 1
                if secs(ch.get("duration")) <= 0:
                    problems.append(f"{name}: duration is not positive")
            walk(ch, name)

    # Spine: children in order, no overlap, contiguous with gaps as elements.
    cursor = Fraction(0)
    for ch in spine:
        off, dur = secs(ch.get("offset")), secs(ch.get("duration"))
        if off != cursor:
            problems.append(
                f"spine/{ch.get('name') or ch.tag}: offset {off} but previous ended {cursor}"
            )
        cursor = off + dur
    if cursor != secs(seq.get("duration")):
        problems.append(
            f"spine ends {cursor}, sequence duration {secs(seq.get('duration'))}"
        )
    walk(spine, "spine")

    # Lane clips inside their parent clip; clips never read past their asset.
    def lanes(clip: ET.Element, where: str) -> None:
        start, dur = secs(clip.get("start")), secs(clip.get("duration"))
        for ch in clip:
            if ch.tag == "clip":
                off, d = secs(ch.get("offset")), secs(ch.get("duration"))
                if off < start or off + d > start + dur:
                    problems.append(
                        f"{where}/{ch.get('name')}: lane clip {off}..{off + d} outside parent {start}..{start + dur}"
                    )
                lanes(ch, f"{where}/{ch.get('name')}")

    for c in spine.findall("clip"):
        lanes(c, "spine/" + (c.get("name") or "clip"))
        v = c.find("video") if c.find("video") is not None else c.find("audio")
        asset = assets.get(v.get("ref")) if v is not None else None
        if asset is not None:
            a_start, a_dur = secs(asset.get("start")), secs(asset.get("duration"))
            if secs(c.get("start")) + secs(c.get("duration")) > a_start + a_dur:
                problems.append(
                    f"spine/{c.get('name')}: reads past the end of its asset"
                )
    summary = {
        "project": projects[0].get("name"),
        "durationS": float(cursor),
        "assets": len(assets),
        "spineClips": len(spine.findall("clip")),
        "videoRefs": counts["video"],
        "audioRefs": counts["audio"],
        "nestedClips": counts["clips"] - len(spine.findall("clip")),
    }
    if counts["video"] == 0:
        problems.append("no video clip")
    return summary, problems


def check(path: Path, dtd: Path | None, expect_clips: int | None = None) -> dict:
    problems: list[str] = []
    dtd_errors = ["no DTD (pass --dtd, set VOX_FCPXML_DTD or use --fetch-dtd)"]
    if dtd is not None:
        dtd_errors = dtd_validate(path, dtd)
    problems += [f"DTD: {e}" for e in dtd_errors]
    summary: dict = {}
    try:
        text = path.read_text()
        if (
            "<!ENTITY" in text
        ):  # entity expansion is never needed here; refuse instead of parsing
            raise ValueError("entity declarations are not allowed")
        summary, found = structure(
            ET.fromstring(text)
        )  # nosemgrep: use-defused-xml-parse
        problems += found
    except (ET.ParseError, ValueError) as e:
        problems.append(f"unreadable: {e}")
    if expect_clips is not None and summary:
        got = summary["videoRefs"] + summary["audioRefs"]
        if got != expect_clips:
            problems.append(f"{got} clip refs, expected {expect_clips}")
    return {
        "file": path.name,
        "dtdValid": dtd is not None and not dtd_errors,
        **summary,
        "problems": problems,
        "pass": not problems,
        "note": "Automated stand-in; not imported in an NLE (Final Cut Pro and Resolve not installed).",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("fcpxml", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dtd")
    ap.add_argument("--fetch-dtd", action="store_true")
    ap.add_argument("--expect-clips", type=int)
    a = ap.parse_args()
    summary = check(a.fcpxml, dtd_path(a.dtd, a.fetch_dtd), a.expect_clips)
    text = json.dumps(summary, indent=2)
    if a.out:
        a.out.write_text(text + "\n")
    print(text)
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
