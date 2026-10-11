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
                    {"name": "a", "path": str(media), "startFrame": 0, "durationFrames": 60,
                     "sourceFrame": 30, "mediaRate": {"num": 30000, "den": 1001}},
                    {"name": "b", "path": str(media), "startFrame": 90, "durationFrames": 30,
                     "sourceFrame": 300},
                ],
            },
            {
                "kind": "video",
                "name": "Layers",
                "clips": [
                    {"name": "title", "path": str(layer), "startFrame": 15, "durationFrames": 45,
                     "sourceFrame": 0},
                ],
            },
            {
                "kind": "audio",
                "name": "A1",
                "clips": [
                    {"name": "a", "path": str(media), "startFrame": 0, "durationFrames": 60,
                     "sourceFrame": 30},
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
