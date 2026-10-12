"""Local image generation with mflux (engine "Image generation provider", plan phase 14d).

Run as `python -I -m vox_py.imagegen`. Two actions (one request, one result, like every tool):

* `install`: download the pinned Hugging Face snapshot of a model into `cacheDir`, quantize it to
  8 bits and save the result in `modelDir` (written beside it and renamed, so a crash never leaves a
  half model). The engine deletes `cacheDir` afterwards. Z-Image-Turbo (Apache-2.0, not gated) is the
  default; FLUX.1-schnell is gated: the user accepts its terms on Hugging Face and sets `HF_TOKEN`
  (the tool never asks for or stores a token).
* `generate`: load `modelDir` and write a PNG. This action runs with `HF_HUB_OFFLINE=1`, so it never
  touches the network: generation works offline once the model is installed.

Z-Image and FLUX need sizes that are multiples of 16 and are best near one megapixel, so the image is
made at the closest such size (at most `MAX_GEN_PIXELS`) and resized to exactly the requested size.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import time
from pathlib import Path

from . import _tool

# model id → (Hugging Face repo, pinned revision, steps, licence). Mirrored by engine/src/imagegen.ts.
MODELS: dict[str, dict] = {
    "z-image-turbo": {
        "repo": "Tongyi-MAI/Z-Image-Turbo",
        "revision": "f332072aa78be7aecdf3ee76d5c247082da564a6",
        "steps": 9,
        "patterns": [
            "model_index.json",
            "scheduler/*",
            "text_encoder/*",
            "tokenizer/*",
            "transformer/*",
            "vae/*",
        ],
    },
    "flux1-schnell": {
        "repo": "black-forest-labs/FLUX.1-schnell",
        "revision": "741f7c3ce8b383c54771c7003378a50191e9efe9",
        "steps": 4,
        "patterns": [
            "model_index.json",
            "scheduler/*",
            "text_encoder/*",
            "text_encoder_2/*",
            "tokenizer/*",
            "tokenizer_2/*",
            "transformer/*",
            "vae/*",
        ],
    },
}
QUANTIZE_BITS = 8
MANIFEST = "vox-model.json"
MULTIPLE = 16
MAX_GEN_PIXELS = 1_200_000
MIN_SIDE = 256

REQUEST: _tool.Spec = {
    "action": (str, True),
    "model": (str, True),
    "modelDir": (str, True),
    "cacheDir": (str, False),
    "prompt": (str, False),
    "width": (int, False),
    "height": (int, False),
    "seed": (int, False),
    "output": (str, False),
}


def plan_size(width: int, height: int) -> tuple[int, int]:
    """The size to generate at: multiples of 16, at most MAX_GEN_PIXELS, same aspect as the request."""
    scale = min(1.0, math.sqrt(MAX_GEN_PIXELS / (width * height)))
    # small requests are generated at least at MIN_SIDE on the short side, then scaled down
    short = min(width, height) * scale
    if short < MIN_SIDE:
        scale *= MIN_SIDE / short

    def snap(v: float) -> int:
        return max(MULTIPLE, round(v * scale / MULTIPLE) * MULTIPLE)

    return snap(width), snap(height)


def _model(req: dict) -> dict:
    spec = MODELS.get(req["model"])
    if spec is None:
        raise _tool.ToolError("INVALID_REQUEST", f"unknown model: {req['model']}")
    return spec


def _gated_hint(model: str) -> str:
    if model == "flux1-schnell":
        return (
            "FLUX.1-schnell is gated: accept its terms at huggingface.co/black-forest-labs/FLUX.1-schnell, "
            "then run again with HF_TOKEN set in the environment"
        )
    return "check the network and try again"


class _Progress:
    """Maps huggingface_hub's byte bars to one 0..1 fraction (throttled to ~4 reports a second)."""

    def __init__(self, lo: float, hi: float, message: str) -> None:
        self.lo, self.hi, self.message = lo, hi, message
        self.total = 0
        self.done = 0
        self.last = 0.0

    def tqdm_class(self):
        from tqdm.auto import tqdm

        outer = self

        class Bar(tqdm):  # type: ignore[misc]
            def __init__(self, *args, **kwargs):
                kwargs["disable"] = True  # no terminal output; progress goes to our JSON lines
                super().__init__(*args, **kwargs)
                self._bytes = kwargs.get("unit") == "B"
                if self._bytes and self.total:
                    outer.total += int(self.total)

            def update(self, n=1):
                r = super().update(n)
                if self._bytes and n:
                    outer.done += int(n)
                    outer.report()
                return r

        return Bar

    def report(self) -> None:
        now = time.monotonic()
        if now - self.last < 0.25 or self.total <= 0:
            return
        self.last = now
        frac = min(1.0, self.done / self.total)
        _tool.progress(self.lo + (self.hi - self.lo) * frac, self.message)


def _install(req: dict) -> dict:
    spec = _model(req)
    cache = req.get("cacheDir")
    if not cache:
        raise _tool.ToolError("INVALID_REQUEST", "missing field: cacheDir")
    model_dir = Path(req["modelDir"])
    if not model_dir.parent.is_dir():
        raise _tool.ToolError("INVALID_REQUEST", "modelDir must be inside an existing folder")
    Path(cache).mkdir(parents=True, exist_ok=True)

    _tool.progress(0.01, "downloading")
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError, RepositoryNotFoundError

    bar = _Progress(0.02, 0.7, "downloading")
    try:
        snapshot = snapshot_download(
            spec["repo"],
            revision=spec["revision"],
            allow_patterns=spec["patterns"],
            cache_dir=cache,
            tqdm_class=bar.tqdm_class(),
        )
    except (GatedRepoError, RepositoryNotFoundError) as exc:
        raise _tool.ToolError(
            "MODEL_GATED", f"{spec['repo']} needs access: {_gated_hint(req['model'])}"
        ) from exc
    except HfHubHTTPError as exc:
        raise _tool.ToolError(
            "NETWORK", f"download failed: {exc}. {_gated_hint(req['model'])}"
        ) from exc
    except OSError as exc:
        raise _tool.ToolError(
            "NETWORK", f"download failed: {exc}. {_gated_hint(req['model'])}"
        ) from exc

    _tool.progress(0.72, "quantizing")
    tmp = model_dir.parent / (model_dir.name + ".part")
    shutil.rmtree(tmp, ignore_errors=True)
    model = _load(req["model"], snapshot, quantize=QUANTIZE_BITS)
    _tool.progress(0.85, "saving")
    model.save_model(str(tmp))
    (tmp / MANIFEST).write_text(
        json.dumps(
            {
                "model": req["model"],
                "repo": spec["repo"],
                "revision": spec["revision"] or Path(snapshot).name,
                "quantize": QUANTIZE_BITS,
            }
        )
    )
    shutil.rmtree(model_dir, ignore_errors=True)
    os.replace(tmp, model_dir)
    _tool.progress(1.0, "installed")
    return {"modelDir": str(model_dir), "bytes": _dir_bytes(model_dir), "quantize": QUANTIZE_BITS}


def _dir_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def _load(model: str, path: str, quantize: int | None = None):
    if model == "z-image-turbo":
        from mflux.models.z_image.variants.z_image import ZImage

        return ZImage(quantize=quantize, model_path=path)
    from mflux.models.common.config.model_config import ModelConfig
    from mflux.models.flux.variants.txt2img.flux import Flux1

    return Flux1(quantize=quantize, model_path=path, model_config=ModelConfig.schnell())


def _generate(req: dict) -> dict:
    # Never touch the network when generating (set before any Hugging Face import).
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    spec = _model(req)
    model_dir = Path(req["modelDir"])
    if not (model_dir / MANIFEST).is_file():
        raise _tool.ToolError("MODEL_MISSING", f"model not installed: {model_dir}")
    prompt = req.get("prompt")
    out = req.get("output")
    if not prompt or not out:
        raise _tool.ToolError("INVALID_REQUEST", "generate needs prompt and output")
    width = _tool.int_at_least(req, "width", 1024, 64, 4096)
    height = _tool.int_at_least(req, "height", 1024, 64, 4096)
    seed = _tool.int_at_least(req, "seed", int(time.time()) % 2**31, 0)
    outp = Path(out)
    if outp.suffix.lower() != ".png" or not outp.parent.is_dir():
        raise _tool.ToolError("INVALID_REQUEST", "output must be a .png in an existing folder")

    gw, gh = plan_size(width, height)
    _tool.progress(0.05, "loading model")
    model = _load(req["model"], str(model_dir))
    _tool.progress(0.25, "generating")
    image = model.generate_image(
        seed=seed, prompt=prompt, num_inference_steps=spec["steps"], height=gh, width=gw
    )
    _tool.progress(0.9, "saving")
    pil = image.image
    if pil.size != (width, height):
        from PIL import Image

        pil = pil.resize((width, height), Image.Resampling.LANCZOS)
    pil.convert("RGB").save(outp, format="PNG")
    _tool.progress(1.0, "done")
    return {"output": str(outp), "width": width, "height": height, "seed": seed}


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    if req["action"] == "install":
        return _install(req)
    if req["action"] == "generate":
        return _generate(req)
    raise _tool.ToolError("INVALID_REQUEST", f"unknown action: {req['action']}")


if __name__ == "__main__":
    _tool.main(handle)
