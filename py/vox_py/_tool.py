"""Shared JSON-in / JSON-out runner for vox_py tools (engine spec "Repository layout").

A tool reads one JSON request on stdin and writes one JSON result on stdout. Progress goes to
stderr as JSON lines `{"progress": 0.42, "message": "..."}`. On failure the tool writes
`{"error": {"code": "...", "message": "..."}}` as its last stderr line and exits with status 1;
stdout stays empty. The engine bridge (`engine/src/py.ts`) validates both sides with zod.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

# Demuxers the media tools accept (R3: untrusted input always gets -format_whitelist). The engine may
# narrow it to the detected type with `formatWhitelist`.
DEFAULT_FORMAT_WHITELIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,wav,aiff,mp3,flac,ogg"


class ToolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def format_progress(progress: float, message: str) -> str:
    return json.dumps({"progress": round(min(max(progress, 0.0), 1.0), 4), "message": message})


def progress(value: float, message: str) -> None:
    print(format_progress(value, message), file=sys.stderr, flush=True)


# ---- request validation (the zod schema on the engine side is the source; these mirror it) ----

Spec = dict[str, tuple[type | tuple[type, ...], bool]]  # field → (types, required)


def check_request(raw: Any, spec: Spec) -> dict:
    if not isinstance(raw, dict):
        raise ToolError("INVALID_REQUEST", "request must be a JSON object")
    unknown = sorted(set(raw) - set(spec))
    if unknown:
        raise ToolError("INVALID_REQUEST", f"unknown fields: {', '.join(unknown)}")
    for name, (types, required) in spec.items():
        if name not in raw:
            if required:
                raise ToolError("INVALID_REQUEST", f"missing field: {name}")
            continue
        value = raw[name]
        if isinstance(value, bool) and bool not in _as_tuple(types):
            raise ToolError("INVALID_REQUEST", f"field {name} has the wrong type")
        if not isinstance(value, types):
            raise ToolError("INVALID_REQUEST", f"field {name} has the wrong type")
        if isinstance(value, float) and not math.isfinite(value):
            raise ToolError("INVALID_REQUEST", f"field {name} must be finite")
        if isinstance(value, str) and not value:
            raise ToolError("INVALID_REQUEST", f"field {name} must not be empty")
    return raw


def _as_tuple(types: type | tuple[type, ...]) -> tuple[type, ...]:
    return types if isinstance(types, tuple) else (types,)


def number_in(raw: dict, name: str, default: float, lo: float, hi: float) -> float:
    value = raw.get(name, default)
    if not (lo < value < hi):
        raise ToolError("INVALID_REQUEST", f"field {name} must be in ({lo}, {hi})")
    return float(value)


def int_at_least(raw: dict, name: str, default: int, lo: int, hi: int | None = None) -> int:
    value = raw.get(name, default)
    if value < lo or (hi is not None and value > hi):
        raise ToolError("INVALID_REQUEST", f"field {name} is out of range")
    return int(value)


def existing_file(path: str) -> Path:
    p = Path(path)
    if "\x00" in path or not p.is_file():
        raise ToolError("INPUT_NOT_FOUND", f"input file not found: {path}")
    return p


# ---- files and processes ----


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def check_sha256(path: Path, expected: str, what: str) -> None:
    actual = sha256_file(path)
    if actual != expected:
        raise ToolError(
            "MODEL_HASH_MISMATCH",
            f"{what} at {path} has SHA-256 {actual}, expected {expected}",
        )


def media_input_args(path: Path, format_whitelist: str) -> list[str]:
    """ffmpeg/ffprobe input options for untrusted media (R3, S5)."""
    return [
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        format_whitelist,
        "-i",
        f"file:{path}",
    ]


def run_capture(argv: list[str], what: str) -> bytes:
    """Run a child process with an argument array (never a shell); fail with its stderr tail."""
    try:
        proc = subprocess.run(argv, capture_output=True, check=False)
    except FileNotFoundError as exc:
        raise ToolError("TOOL_MISSING", f"{argv[0]} not found ({what})") from exc
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.decode("utf-8", "replace").strip().splitlines()[-10:])
        raise ToolError("MEDIA_UNREADABLE", f"{what} failed (exit {proc.returncode}): {tail}")
    return proc.stdout


# ---- entry point ----


def main(handler: Callable[[dict], dict]) -> None:
    # Libraries (MediaPipe, mlx, onnxruntime) may print to fd 1. Point fd 1 at stderr while the
    # handler runs, so stdout carries exactly one JSON result.
    sys.stdout.flush()
    saved_stdout = os.dup(1)
    os.dup2(2, 1)
    try:
        try:
            raw = json.loads(sys.stdin.read())
        except ValueError as exc:
            raise ToolError("INVALID_REQUEST", f"request is not valid JSON: {exc}") from exc
        result = handler(raw)
        out = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except ToolError as exc:
        _fail(exc.code, exc.message)
    except Exception as exc:  # noqa: BLE001 - every failure must end as one error line
        _fail("TOOL_FAILED", f"{type(exc).__name__}: {exc}")
    sys.stdout.flush()
    os.dup2(saved_stdout, 1)
    os.close(saved_stdout)
    sys.stdout.write(out + "\n")
    sys.stdout.flush()


def _fail(code: str, message: str) -> None:
    sys.stdout.flush()
    print(json.dumps({"error": {"code": code, "message": message}}), file=sys.stderr, flush=True)
    sys.exit(1)
