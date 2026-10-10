"""Silero VAD speech gate through onnxruntime, no torch (engine "Speech gate", plan D-15).

Run as `python -I -m vox_py.vad`. Request: `{ audioPath, ffmpeg?, formatWhitelist?, threshold?,
minSpeechMs?, minSilenceMs?, speechPadMs? }`. Result: `{ speechRegions: {startMs, endMs}[],
durationMs, model: { file, sha256 } }`. The model is vendored at `models/silero_vad.onnx`
(Silero VAD v6.2.3, MIT) and its SHA-256 is checked on every load; nothing is downloaded.
The post-processing follows the upstream `get_speech_timestamps` (v6.2.3) defaults.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import _tool

MODEL_PATH = Path(__file__).resolve().parent / "models" / "silero_vad.onnx"
# Upstream: https://github.com/snakers4/silero-vad/blob/v6.2.3/src/silero_vad/data/silero_vad.onnx
# (tag v6.2.3, commit 5cd7945676eb32225748052e2e6a0580e4686a08). Pinned in plan R5.
MODEL_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"

SAMPLE_RATE = 16000
WINDOW = 512  # samples per model call at 16 kHz (32 ms)
CONTEXT = 64  # samples of the previous window prepended to each call

DEFAULTS = {"threshold": 0.5, "minSpeechMs": 250, "minSilenceMs": 100, "speechPadMs": 30}


class SileroVad:
    def __init__(self, path: Path):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(
            str(path), sess_options=opts, providers=["CPUExecutionProvider"]
        )

    def probabilities(self, audio: np.ndarray) -> list[float]:
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros((1, CONTEXT), dtype=np.float32)
        sr = np.array(SAMPLE_RATE, dtype=np.int64)
        probs: list[float] = []
        for start in range(0, len(audio), WINDOW):
            chunk = audio[start : start + WINDOW]
            if len(chunk) < WINDOW:
                chunk = np.pad(chunk, (0, WINDOW - len(chunk)))
            x = np.concatenate([context, chunk.reshape(1, -1)], axis=1).astype(np.float32)
            out, state = self.session.run(None, {"input": x, "state": state, "sr": sr})
            context = x[:, -CONTEXT:]
            probs.append(float(out[0][0]))
        return probs


def load_model(path: Path = MODEL_PATH) -> SileroVad:
    """Load the vendored model after checking its SHA-256 (fails on any change)."""
    if not path.is_file():
        raise _tool.ToolError("MODEL_MISSING", f"vendored VAD model not found: {path}")
    _tool.check_sha256(path, MODEL_SHA256, "Silero VAD model")
    return SileroVad(path)


def regions_from_probs(
    probs: list[float],
    total_samples: int,
    threshold: float = DEFAULTS["threshold"],
    min_speech_ms: int = DEFAULTS["minSpeechMs"],
    min_silence_ms: int = DEFAULTS["minSilenceMs"],
    speech_pad_ms: int = DEFAULTS["speechPadMs"],
) -> list[tuple[int, int]]:
    """Speech regions in samples, from per-window probabilities (upstream algorithm)."""
    neg_threshold = max(threshold - 0.15, 0.01)
    min_speech = SAMPLE_RATE * min_speech_ms / 1000
    min_silence = SAMPLE_RATE * min_silence_ms / 1000
    pad = int(SAMPLE_RATE * speech_pad_ms / 1000)

    speeches: list[list[int]] = []
    triggered = False
    start = 0
    temp_end = 0
    for i, p in enumerate(probs):
        cur = WINDOW * i
        if p >= threshold and temp_end:
            temp_end = 0
        if p >= threshold and not triggered:
            triggered = True
            start = cur
            continue
        if p < neg_threshold and triggered:
            if not temp_end:
                temp_end = cur
            if cur - temp_end < min_silence:
                continue
            if temp_end - start > min_speech:
                speeches.append([start, temp_end])
            triggered = False
            temp_end = 0
    if triggered and total_samples - start > min_speech:
        speeches.append([start, total_samples])

    for i, s in enumerate(speeches):
        if i == 0:
            s[0] = max(0, s[0] - pad)
        if i != len(speeches) - 1:
            nxt = speeches[i + 1]
            silence = nxt[0] - s[1]
            if silence < 2 * pad:
                s[1] += silence // 2
                nxt[0] = max(0, nxt[0] - silence // 2)
            else:
                s[1] = min(total_samples, s[1] + pad)
                nxt[0] = max(0, nxt[0] - pad)
        else:
            s[1] = min(total_samples, s[1] + pad)
    return [(a, b) for a, b in speeches]


def to_ms(samples: int) -> int:
    return round(samples * 1000 / SAMPLE_RATE)


def speech_regions(
    audio: np.ndarray, model: SileroVad | None = None, **opts
) -> list[dict[str, int]]:
    """Speech regions `{startMs, endMs}` of 16 kHz mono float32 audio."""
    model = model or load_model()
    probs = model.probabilities(audio)
    return [
        {"startMs": to_ms(a), "endMs": to_ms(b)}
        for a, b in regions_from_probs(probs, len(audio), **opts)
    ]


def decode_audio(path: Path, ffmpeg: str, format_whitelist: str) -> np.ndarray:
    """Decode any audio/video file to 16 kHz mono float32 with ffmpeg (no shell)."""
    argv = [
        ffmpeg,
        "-nostdin",
        "-v",
        "error",
        *_tool.media_input_args(path, format_whitelist),
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "pipe:1",
    ]
    raw = _tool.run_capture(argv, "ffmpeg audio decode")
    return np.frombuffer(raw, dtype="<f4").copy()


REQUEST: _tool.Spec = {
    "audioPath": (str, True),
    "ffmpeg": (str, False),
    "formatWhitelist": (str, False),
    "threshold": ((int, float), False),
    "minSpeechMs": (int, False),
    "minSilenceMs": (int, False),
    "speechPadMs": (int, False),
}


def vad_options(raw: dict) -> dict:
    return {
        "threshold": _tool.number_in(raw, "threshold", DEFAULTS["threshold"], 0.0, 1.0),
        "min_speech_ms": _tool.int_at_least(raw, "minSpeechMs", DEFAULTS["minSpeechMs"], 0),
        "min_silence_ms": _tool.int_at_least(raw, "minSilenceMs", DEFAULTS["minSilenceMs"], 0),
        "speech_pad_ms": _tool.int_at_least(raw, "speechPadMs", DEFAULTS["speechPadMs"], 0),
    }


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    opts = vad_options(req)
    path = _tool.existing_file(req["audioPath"])
    model = load_model()
    _tool.progress(0.0, "decoding audio")
    audio = decode_audio(
        path,
        req.get("ffmpeg", "ffmpeg"),
        req.get("formatWhitelist", _tool.DEFAULT_FORMAT_WHITELIST),
    )
    _tool.progress(0.3, "detecting speech")
    regions = speech_regions(audio, model, **opts)
    _tool.progress(1.0, "done")
    return {
        "speechRegions": regions,
        "durationMs": to_ms(len(audio)),
        "model": {"file": MODEL_PATH.name, "sha256": MODEL_SHA256},
    }


if __name__ == "__main__":
    _tool.main(handle)
