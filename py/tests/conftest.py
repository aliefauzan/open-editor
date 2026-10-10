"""Shared pytest helpers for the vox_py tools.

Tier rule (plan R3, D-16): tests marked `local` need local-only resources (generated fixtures from
`packages/engine/test/fixtures/make.sh`, downloaded models, mlx-whisper) and are skipped when `CI` is
set. Locally a missing fixture fails the test instead of skipping it, so nothing passes silently.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PY_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PY_ROOT.parent
SCHEMAS = Path(__file__).resolve().parent / "schemas"
DATA = Path(__file__).resolve().parent / "data"
FIXTURES_OUT = Path(
    os.environ.get("VOX_FIXTURES_OUT", REPO_ROOT / "packages/engine/test/fixtures/out")
)


def pytest_configure(config):
    # Registered here too, so `uv run --project py pytest` from the repo root (no py/ ini) knows it.
    config.addinivalue_line(
        "markers",
        "local: needs local-only resources (real models, generated fixtures); skipped when CI is set",
    )


def pytest_collection_modifyitems(config, items):
    if not os.environ.get("CI"):
        return
    skip = pytest.mark.skip(reason="local tier: skipped when CI is set (R3)")
    for item in items:
        if "local" in item.keywords:
            item.add_marker(skip)


def fixture_file(name: str) -> Path:
    path = FIXTURES_OUT / name
    if not path.is_file():
        pytest.fail(
            f"missing fixture {path}; run `bash packages/engine/test/fixtures/make.sh` first"
        )
    return path


def run_tool(tool: str, request: dict, timeout: float = 1800) -> tuple[int, dict | None, str]:
    """Run `python -I -m vox_py.<tool>` the way the engine bridge does: JSON in, JSON out."""
    proc = subprocess.run(
        [sys.executable, "-I", "-m", f"vox_py.{tool}"],
        input=json.dumps(request),
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    result = json.loads(proc.stdout) if proc.returncode == 0 else None
    return proc.returncode, result, proc.stderr


def validate(schema_name: str, instance: dict) -> None:
    from jsonschema import Draft202012Validator

    schema = json.loads((SCHEMAS / schema_name).read_text())
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(instance)


def stderr_error(stderr: str) -> dict:
    """The last JSON line on stderr that carries `error`."""
    for line in reversed(stderr.strip().splitlines()):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and "error" in obj:
            return obj["error"]
    raise AssertionError(f"no error line on stderr:\n{stderr}")
