"""Vox Studio Python tools. Each tool is a module run as `python -I -m vox_py.<tool>`."""

import os

# The tools must not phone home. onnxruntime uploads usage events to Microsoft from a background
# thread that can abort the process at exit (exit 134). Set before any tool imports a library.
for _name in ("ORT_DISABLE_TELEMETRY", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
    os.environ[_name] = "1"

__version__ = "0.0.0"
