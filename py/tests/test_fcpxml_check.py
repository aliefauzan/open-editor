"""scripts/fcpxml-check.py: DTD + structure stand-in for the FCPXML import check (phase 14g)."""

import importlib.util
from pathlib import Path

import pytest
from conftest import run_tool
from test_timeline import write_request

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "fcpxml-check.py"
spec = importlib.util.spec_from_file_location("fcpxml_check", SCRIPT)
chk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chk)
DTD = chk.dtd_path(None, False)  # cached copy only; tests never download


@pytest.fixture
def exported(tmp_path):
    media = tmp_path / "m.mp4"
    media.write_bytes(b"x")
    layer = tmp_path / "cut-layers" / "title.mov"
    layer.parent.mkdir()
    layer.write_bytes(b"y")
    req = write_request(tmp_path, media, layer)
    req.update({"format": "fcpxml", "output": str(tmp_path / "cut.fcpxml"), "width": 1080})
    req["height"] = 1920
    req["rate"] = {"num": 30, "den": 1}
    for t in req["tracks"]:
        for c in t["clips"]:
            c.pop("mediaRate", None)
            c["mediaDurationFrames"] = 900
    code, _, stderr = run_tool("timeline", req)
    assert code == 0, stderr
    return Path(req["output"]), media


def problems_without_dtd(res):
    return [p for p in res["problems"] if not p.startswith("DTD: no DTD")]


def test_valid_export_passes_structure_and_dtd(exported):
    path, _ = exported
    res = chk.check(path, DTD, expect_clips=4)
    assert problems_without_dtd(res) == []
    assert res["spineClips"] == 2 and res["assets"] == 2 and res["durationS"] == 4.0
    if DTD is not None:
        assert res["dtdValid"] and res["pass"]


def test_missing_asset_file_and_broken_ref_are_reported(exported):
    path, media = exported
    media.unlink()
    res = chk.check(path, DTD)
    assert any("missing file" in p for p in res["problems"])
    path.write_text(path.read_text().replace('ref="r2"', 'ref="r9"', 1))
    res = chk.check(path, DTD)
    assert any("ref r9 not an asset" in p for p in res["problems"])
    assert res["pass"] is False


def test_gap_in_spine_and_wrong_sequence_duration_are_reported(exported):
    path, _ = exported
    text = path.read_text()
    path.write_text(
        text.replace('offset="3s"', 'offset="5s"').replace(
            '<sequence duration="4/1s"', '<sequence duration="9/1s"'
        )
    )
    res = chk.check(path, DTD)
    assert any("offset 5 but previous ended 3" in p for p in res["problems"])
    assert any("sequence duration 9" in p for p in res["problems"])


def test_entity_declarations_are_refused(exported):
    path, _ = exported
    path.write_text(
        path.read_text().replace("<!DOCTYPE fcpxml>", '<!DOCTYPE fcpxml [<!ENTITY x "y">]>')
    )
    res = chk.check(path, DTD)
    assert any("entity" in p for p in res["problems"])


@pytest.mark.skipif(
    DTD is None, reason="FCPXML DTD not cached (run scripts/fcpxml-check.py --fetch-dtd)"
)
def test_dtd_rejects_a_foreign_element(exported):
    path, _ = exported
    path.write_text(path.read_text().replace("<spine>", "<spine><bogus/>"))
    res = chk.check(path, DTD)
    assert res["dtdValid"] is False and any(p.startswith("DTD:") for p in res["problems"])
