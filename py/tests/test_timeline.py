"""timeline: OTIO writer + checker (engine "Stages", `export-timeline`; phase 05 steps 3 and 7)."""

import json

from conftest import run_tool, stderr_error, validate


def write_request(tmp_path, media, layer):
    return {
        "output": str(tmp_path / "cut.otio"),
        "name": "Clip 1",
        "rate": {"num": 30000, "den": 1001},
        "tracks": [
            {
                "kind": "video",
                "name": "V1",
                "clips": [
                    {
                        "name": "a",
                        "path": str(media),
                        "startFrame": 0,
                        "durationFrames": 60,
                        "sourceFrame": 30,
                        "mediaRate": {"num": 30000, "den": 1001},
                    },
                    {
                        "name": "b",
                        "path": str(media),
                        "startFrame": 90,
                        "durationFrames": 30,
                        "sourceFrame": 300,
                    },
                ],
            },
            {
                "kind": "video",
                "name": "Layers",
                "clips": [
                    {
                        "name": "title",
                        "path": str(layer),
                        "startFrame": 15,
                        "durationFrames": 45,
                        "sourceFrame": 0,
                    },
                ],
            },
            {
                "kind": "audio",
                "name": "A1",
                "clips": [
                    {
                        "name": "a",
                        "path": str(media),
                        "startFrame": 0,
                        "durationFrames": 60,
                        "sourceFrame": 30,
                    },
                ],
            },
        ],
    }


def test_write_then_check_round_trip(tmp_path):
    import opentimelineio as otio

    media = tmp_path / "media with space.mp4"
    media.write_bytes(b"x")
    layer = tmp_path / "cut-layers" / "title.mov"
    layer.parent.mkdir()
    layer.write_bytes(b"y")
    req = write_request(tmp_path, media, layer)
    validate("timeline.request.json", req)
    code, result, stderr = run_tool("timeline", req)
    assert code == 0, stderr
    validate("timeline.result.json", result)
    assert result == {"output": req["output"], "tracks": 3, "clips": 4}

    tl = otio.adapters.read_from_file(req["output"])
    v1 = tl.tracks[0]
    assert [type(i).__name__ for i in v1] == ["Clip", "Gap", "Clip"]
    assert v1[1].duration().value == 30
    assert v1[0].source_range.start_time.value == 30
    assert abs(v1[0].source_range.start_time.rate - 30000 / 1001) < 1e-9
    assert tl.tracks[2].kind == otio.schema.TrackKind.Audio
    json.loads((tmp_path / "cut.otio").read_text())  # OTIO JSON

    check = {"mode": "check", "path": req["output"]}
    validate("timeline.request.json", check)
    code, res, stderr = run_tool("timeline", check)
    assert code == 0, stderr
    validate("timeline.result.json", res)
    assert len(res["clips"]) == 4 and all(c["exists"] for c in res["clips"])

    layer.unlink()
    code, res, _ = run_tool("timeline", check)
    assert [c["exists"] for c in res["clips"]] == [True, True, False, True]


def test_overlap_and_relative_paths_are_refused(tmp_path):
    req = write_request(tmp_path, tmp_path / "m.mp4", tmp_path / "l.mov")
    req["tracks"][0]["clips"][1]["startFrame"] = 10
    code, _, stderr = run_tool("timeline", req)
    assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST"
    req = write_request(tmp_path, "relative/m.mp4", tmp_path / "l.mov")
    code, _, stderr = run_tool("timeline", req)
    assert code == 1 and "absolute" in stderr_error(stderr)["message"]


def test_fcpxml_write_is_valid_xml_with_clips_timing_and_assets(tmp_path):
    import xml.etree.ElementTree as ET

    media = tmp_path / "media with space.mp4"
    media.write_bytes(b"x")
    layer = tmp_path / "cut-layers" / "title.mov"
    layer.parent.mkdir()
    layer.write_bytes(b"y")
    req = write_request(tmp_path, media, layer)
    req["format"] = "fcpxml"
    req["output"] = str(tmp_path / "cut.fcpxml")
    req["width"], req["height"] = 1080, 1920
    req["rate"] = {"num": 30, "den": 1}
    for t in req["tracks"]:
        for c in t["clips"]:
            c.pop("mediaRate", None)
            c["mediaDurationFrames"] = 900
    validate("timeline.request.json", req)
    code, result, stderr = run_tool("timeline", req)
    assert code == 0, stderr
    validate("timeline.result.json", result)
    assert result == {"output": req["output"], "tracks": 3, "clips": 4}

    root = ET.parse(req["output"]).getroot()
    assert root.tag == "fcpxml" and root.get("version") == "1.8"
    assets = root.findall("./resources/asset")
    assert sorted(a.get("src") for a in assets) == sorted([media.as_uri(), layer.as_uri()])
    assert {a.get("duration") for a in assets} == {"30/1s"}  # 900 frames at 30 fps
    fmt = root.find("resources/format")
    assert (fmt.get("width"), fmt.get("height")) == ("1080", "1920")
    assert root.findall("asset-clip") == []
    assert root.find("event/project") is not None and "uid" not in root.find("event/project").attrib
    seq = root.find("./event/project/sequence")
    assert seq is not None and seq.get("duration") == "4/1s"  # last V1 clip ends at frame 120
    spine = seq.find("spine")
    assert [e.tag for e in spine] == ["clip", "gap", "clip"]
    assert [e.get("offset") for e in spine] == ["0s", "2s", "3s"]
    assert [e.get("duration") for e in spine] == ["2/1s", "1/1s", "1/1s"]
    assert spine[0].get("start") == "1s" and spine[2].get("start") == "10s"


def test_fcpxml_output_must_match_format(tmp_path):
    media = tmp_path / "m.mp4"
    media.write_bytes(b"x")
    layer = tmp_path / "l.mov"
    layer.write_bytes(b"y")
    req = write_request(tmp_path, media, layer)
    req["format"] = "fcpxml"  # output still ends .otio
    code, _, stderr = run_tool("timeline", req)
    assert code != 0 and "INVALID_REQUEST" in stderr


def test_time_scalar_adds_a_linear_time_warp(tmp_path):
    """Clip speed (plan D-62): OTIO gets a LinearTimeWarp; FCPXML still writes (no speed there, D-64)."""
    import opentimelineio as otio

    media = tmp_path / "m.mp4"
    media.write_bytes(b"x")
    layer = tmp_path / "l.mov"
    layer.write_bytes(b"y")
    req = write_request(tmp_path, media, layer)
    req["tracks"][0]["clips"][0]["timeScalar"] = 2
    req["tracks"][2]["clips"][0]["timeScalar"] = 0.5
    validate("timeline.request.json", req)
    code, _, stderr = run_tool("timeline", req)
    assert code == 0, stderr
    tl = otio.adapters.read_from_file(req["output"])
    a, b = [c for c in tl.tracks[0] if isinstance(c, otio.schema.Clip)]
    assert [type(e).__name__ for e in a.effects] == ["LinearTimeWarp"]
    assert a.effects[0].time_scalar == 2.0 and len(b.effects) == 0
    # the source range keeps the timeline length (60 frames)
    assert a.source_range.duration.value == 60
    audio = next(c for c in tl.tracks[2] if isinstance(c, otio.schema.Clip))
    assert audio.effects[0].time_scalar == 0.5

    req["format"], req["output"] = "fcpxml", str(tmp_path / "cut.fcpxml")
    req["rate"] = {"num": 30, "den": 1}
    for t in req["tracks"]:
        for c in t["clips"]:
            c.pop("mediaRate", None)
    code, _, stderr = run_tool("timeline", req)
    assert code == 0, stderr

    req = write_request(tmp_path, media, layer)
    req["tracks"][0]["clips"][0]["timeScalar"] = 5
    code, _, stderr = run_tool("timeline", req)
    assert code == 1 and "timeScalar" in stderr_error(stderr)["message"]
