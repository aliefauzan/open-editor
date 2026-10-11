import subprocess
import sys
import zipfile
from pathlib import Path

import vox_py

PROJECT = Path(__file__).resolve().parent.parent


def test_version_is_semver_string():
    parts = vox_py.__version__.split(".")
    assert len(parts) == 3 and all(p.isdigit() for p in parts)


def test_module_runs_isolated():
    out = subprocess.run(
        [sys.executable, "-I", "-m", "vox_py"], capture_output=True, text=True, check=True
    )
    assert out.stdout.strip() == f"vox_py {vox_py.__version__}"


def test_models_folder_documents_future_contents():
    readme = (PROJECT / "vox_py" / "models" / "README.md").read_text()
    assert "silero_vad.onnx" in readme and "SHA-256" in readme


def test_built_wheel_ships_the_vendored_vad_model_and_licence(tmp_path):
    subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path), str(PROJECT)],
        check=True,
        capture_output=True,
    )
    wheel = next(tmp_path.glob("vox_py-*.whl"))
    names = zipfile.ZipFile(wheel).namelist()
    assert "vox_py/models/silero_vad.onnx" in names
    assert "vox_py/models/LICENSE.silero" in names
    assert "vox_py/models/placeholder.onnx" not in names


def test_importing_the_package_switches_off_library_telemetry():
    # onnxruntime uploads usage events to Microsoft and its upload thread can abort the process at
    # exit (exit 134); the engine sets these too, this covers direct `python -m vox_py.<tool>` runs.
    env = {"PATH": "/usr/bin:/bin"}
    code = "import os, vox_py; print(os.environ.get('ORT_DISABLE_TELEMETRY'), os.environ.get('HF_HUB_DISABLE_TELEMETRY'))"
    out = subprocess.run(
        [sys.executable, "-I", "-c", code], capture_output=True, text=True, check=True, env=env
    )
    assert out.stdout.split() == ["1", "1"]
