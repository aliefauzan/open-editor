"""The JSON-in / JSON-out protocol every vox_py tool shares (engine "Repository layout")."""

import json
import subprocess
import sys

import pytest
from conftest import run_tool, stderr_error, validate

TOOLS = ["vad", "transcribe", "facetrack", "doctext", "audioqa"]


@pytest.mark.parametrize("tool", TOOLS)
def test_invalid_json_fails_with_invalid_request(tool):
    proc = subprocess.run(
        [sys.executable, "-I", "-m", f"vox_py.{tool}"],
        input="{not json",
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 1
    assert proc.stdout == ""
    err = stderr_error(proc.stderr)
    validate("error.json", {"error": err})
    assert err["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize("tool", TOOLS)
def test_unknown_field_fails_with_invalid_request(tool):
    code, result, stderr = run_tool(tool, {"bogus": 1})
    assert code == 1 and result is None
    err = stderr_error(stderr)
    assert err["code"] == "INVALID_REQUEST"
    assert "bogus" in err["message"]


@pytest.mark.parametrize("tool", TOOLS)
def test_request_schema_is_valid_json_schema(tool):
    from conftest import SCHEMAS
    from jsonschema import Draft202012Validator

    for kind in ("request", "result"):
        Draft202012Validator.check_schema(json.loads((SCHEMAS / f"{tool}.{kind}.json").read_text()))


def test_progress_lines_match_schema():
    from vox_py import _tool

    line = _tool.format_progress(0.42, "decoding")
    validate("progress.json", json.loads(line))
