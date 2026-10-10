"""Measurements for the audio QA tool: PCM decode, BS.1770 loudness, true peak, onsets, spectra.

numpy only; ffmpeg is used for decoding and resampling (plan D-14). All times are milliseconds.
"""

from __future__ import annotations

import itertools
import json
import subprocess
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import _tool

THRESHOLDS_PATH = Path(__file__).resolve().parent / "audioqa_thresholds.json"
RATE = 48000

# ITU-R BS.1770-4 K-weighting at 48 kHz: stage 1 high shelf, stage 2 RLB high-pass.
_K1_B = (1.53512485958697, -2.69169618940638, 1.19839281085285)
_K1_A = (1.0, -1.69065929318241, 0.73248077421585)
_K2_B = (1.0, -2.0, 1.0)
_K2_A = (1.0, -1.99004745483398, 0.99007225036621)
_K_TAPS = 16384  # the cascade's impulse response is below 1e-70 long before this (pole at 0.99)


@lru_cache(maxsize=1)
def load_thresholds() -> dict:
    return json.loads(THRESHOLDS_PATH.read_text())


def _impulse_response(b: tuple, a: tuple, n: int) -> np.ndarray:
    h = np.zeros(n)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(n):
        x0 = 1.0 if i == 0 else 0.0
        y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        h[i] = y0
        x2, x1, y2, y1 = x1, x0, y1, y0
    return h


@lru_cache(maxsize=1)
def _k_kernel() -> np.ndarray:
    h1 = _impulse_response(_K1_B, _K1_A, _K_TAPS)
    return np.convolve(h1, _impulse_response(_K2_B, _K2_A, _K_TAPS))[:_K_TAPS]


def k_weight(x: np.ndarray) -> np.ndarray:
    """K-weighted copy of a mono 48 kHz signal (FIR form of the two BS.1770 biquads).

    Overlap-save in blocks of 2^20 samples, so memory stays flat for long inputs.
    """
    kernel = _k_kernel()
    taps, block = len(kernel), 1 << 20
    size = 1 << (block + taps - 2).bit_length()
    kernel_spec = np.fft.rfft(kernel, size)
    padded = np.concatenate([np.zeros(taps - 1), x.astype(np.float64)])
    out = np.empty(len(x))
    for start in range(0, len(x), block):
        seg = padded[start : start + block + taps - 1]
        y = np.fft.irfft(np.fft.rfft(seg, size) * kernel_spec, size)
        count = len(seg) - (taps - 1)
        out[start : start + count] = y[taps - 1 : taps - 1 + count]
    return out


# ---- decode ----


def decode(
    path: Path,
    ffmpeg: str,
    whitelist: str,
    rate: int = RATE,
    channels: int | None = None,
    max_s: float | None = None,
) -> np.ndarray:
    """Decode the first audio stream to float32 PCM, shape (samples, channels).

    channels=None keeps mono and stereo as they are and downmixes more channels to stereo. With
    `max_s` ffmpeg stops reading after that many seconds plus one (callers compare the length).
    """
    if channels is None:
        channels = _channel_count(path, ffmpeg, whitelist)
        channels = min(channels, 2)
    limit = ["-t", f"{max_s + 1:.3f}"] if max_s else []
    argv = [
        ffmpeg, "-nostdin", "-v", "error",
        *_tool.media_input_args(path, whitelist),
        "-map", "0:a:0", "-ac", str(channels), "-ar", str(rate), *limit, "-f", "f32le", "pipe:1",
    ]  # fmt: skip
    raw = np.frombuffer(_tool.run_capture(argv, "ffmpeg audio decode"), dtype="<f4")
    out = raw[: len(raw) // channels * channels].reshape(-1, channels)
    if len(out) == 0:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"no audio samples in {path}")
    if not np.isfinite(out).all():
        raise _tool.ToolError("MEDIA_UNREADABLE", f"{path} decodes to non-finite samples")
    return out


def sample_peak_stream(path: Path, ffmpeg: str, whitelist: str, rate: int, max_s: float) -> float:
    """Largest |sample| of the first audio stream resampled to `rate`, read in chunks."""
    argv = [
        ffmpeg, "-nostdin", "-v", "error",
        *_tool.media_input_args(path, whitelist),
        "-map", "0:a:0", "-ar", str(rate), "-t", f"{max_s + 1:.3f}", "-f", "f32le", "pipe:1",
    ]  # fmt: skip
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError as exc:
        raise _tool.ToolError("TOOL_MISSING", f"{argv[0]} not found (true peak)") from exc
    peak, rest = 0.0, b""
    assert proc.stdout is not None and proc.stderr is not None
    while chunk := proc.stdout.read(1 << 22):
        data = rest + chunk
        usable = len(data) // 4 * 4
        arr = np.frombuffer(data[:usable], dtype="<f4")
        if not np.isfinite(arr).all():
            proc.kill()
            raise _tool.ToolError("MEDIA_UNREADABLE", f"{path} decodes to non-finite samples")
        if len(arr):
            peak = max(peak, float(np.abs(arr).max()))
        rest = data[usable:]
    err = proc.stderr.read().decode("utf-8", "replace").strip().splitlines()[-10:]
    if proc.wait() != 0:
        raise _tool.ToolError(
            "MEDIA_UNREADABLE", "ffmpeg true-peak decode failed: " + "\n".join(err)
        )
    return peak


def _channel_count(path: Path, ffmpeg: str, whitelist: str) -> int:
    ffprobe = str(Path(ffmpeg).with_name("ffprobe")) if "/" in ffmpeg else "ffprobe"
    argv = [
        ffprobe, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=channels", "-of", "csv=p=0",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", whitelist, f"file:{path}",
    ]  # fmt: skip
    out = _tool.run_capture(argv, "ffprobe audio channels").decode().strip()
    if not out.isdigit() or int(out) < 1:
        raise _tool.ToolError("MEDIA_UNREADABLE", f"no audio stream in {path}")
    return int(out)


def to_db(value: float | np.ndarray, floor: float = -120.0):
    return np.maximum(20 * np.log10(np.maximum(value, 1e-12)), floor)


# ---- loudness ----


def block_powers(channels: np.ndarray) -> np.ndarray:
    """Per 400 ms block (100 ms hop) sum over channels of the K-weighted mean square."""
    block, hop = int(RATE * 0.4), int(RATE * 0.1)
    n = channels.shape[0]
    if n < block:
        return np.zeros(0)
    total = np.zeros((n - block) // hop + 1)
    for c in range(channels.shape[1]):
        sq = k_weight(channels[:, c]) ** 2
        csum = np.concatenate([[0.0], np.cumsum(sq)])
        starts = np.arange(len(total)) * hop
        total += (csum[starts + block] - csum[starts]) / block
    return total


def integrated_lufs(channels: np.ndarray) -> float | None:
    """Gated integrated loudness (BS.1770-4); None when nothing is above the absolute gate."""
    z = block_powers(channels)
    lk = -0.691 + 10 * np.log10(np.maximum(z, 1e-30))
    z = z[lk > -70.0]
    if len(z) == 0:
        return None
    rel = -0.691 + 10 * np.log10(z.mean()) - 10.0
    z = z[(-0.691 + 10 * np.log10(z)) > rel]
    return float(-0.691 + 10 * np.log10(z.mean())) if len(z) else None


def peak_dbtp(sample_peak_at_4x: float) -> float:
    """True peak in dBTP from the largest sample of the 4x oversampled signal."""
    return float(to_db(sample_peak_at_4x))


def clipped_samples(channels: np.ndarray, level: float, min_run: int) -> int:
    """Samples in runs of at least `min_run` consecutive samples at or above `level` (any channel)."""
    hit = (np.abs(channels) >= level).any(axis=1)
    if not hit.any():
        return 0
    edges = np.diff(np.concatenate([[0], hit.astype(np.int8), [0]]))
    runs = np.flatnonzero(edges == -1) - np.flatnonzero(edges == 1)
    return int(runs[runs >= min_run].sum())


# ---- onsets ----


def envelope_db(x: np.ndarray, hop_ms: int) -> np.ndarray:
    """Peak |x| per hop, in dBFS."""
    hop = RATE * hop_ms // 1000
    frames = len(x) // hop
    if frames == 0:
        return np.zeros(0)
    peaks = np.abs(x[: frames * hop]).reshape(frames, hop).max(axis=1)
    return to_db(peaks)


def find_onsets(x: np.ndarray, cfg: dict) -> list[dict]:
    """Hits in a mono signal: `{ms, peakDbfs}` per onset.

    A frame above the floor starts an onset when the signal was below the floor for the preceding
    `onsetSilenceMs` (a swell from silence is one event) or the frame is at least `onsetRiseDb` above
    the loudest frame of the preceding `onsetLookbackMs` (a hit on top of a tail).
    Frames under the absolute `onsetFloorDbfs` are silence.
    After an onset the detector re-arms once the envelope has dropped `onsetRearmDropDb` below that
    event's peak, so a tail is never a new hit but a hit on top of a tail is.
    """
    hop_ms = cfg["onsetHopMs"]
    env = envelope_db(x, hop_ms)
    look = max(1, cfg["onsetLookbackMs"] // hop_ms)
    rise, drop = cfg["onsetRiseDb"], cfg["onsetRearmDropDb"]
    if len(env) == 0:
        return []
    floor = cfg["onsetFloorDbfs"]
    onsets: list[dict] = []
    armed, peak, current = True, -120.0, None
    quiet_needed = max(1, cfg["onsetSilenceMs"] // hop_ms)
    quiet = quiet_needed  # frames in a row below the floor (the file starts in silence)
    for i, level in enumerate(env):
        was_quiet = quiet
        quiet = quiet + 1 if level < floor else 0
        if armed:
            ref = env[max(0, i - look) : i].max() if i > 0 else -120.0
            if level >= floor and (was_quiet >= quiet_needed or level - ref >= rise):
                current = {"ms": i * hop_ms, "peakDbfs": float(level)}
                onsets.append(current)
                armed, peak = False, level
        else:
            peak = max(peak, level)
            if current is not None:
                current["peakDbfs"] = float(peak)
            if level <= peak - drop or level < floor:
                armed = True
    return onsets


def speech_active_fraction(speech: np.ndarray, start_ms: float, end_ms: float, cfg: dict) -> float:
    """Share of 20 ms frames in [start, end) of a speech stem that are above the frame floor."""
    frame = RATE * cfg["speechFrameMs"] // 1000
    a, b = int(start_ms * RATE / 1000), int(end_ms * RATE / 1000)
    seg = speech[a:b]
    n = len(seg) // frame
    if n == 0:
        return 0.0
    rms = np.sqrt((seg[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    return float((to_db(rms) > cfg["speechFrameFloorDbfs"]).mean())


def window_ms_power(kw: np.ndarray, start_ms: float, end_ms: float) -> float:
    """Mean square of a K-weighted signal in [start, end)."""
    a, b = int(start_ms * RATE / 1000), int(end_ms * RATE / 1000)
    seg = kw[a:b]
    return float((seg**2).mean()) if len(seg) else 0.0


def lu_between(loud: float, quiet: float) -> float:
    """Loudness of `loud` minus `quiet` in LU (mean squares); large when `quiet` is silent."""
    return float(10 * np.log10(max(loud, 1e-20) / max(quiet, 1e-20)))


# ---- spectra (kit mode) ----


def peak_energy_share(x: np.ndarray, half_width_hz: float) -> float:
    """Share of the spectral energy within +-half_width_hz of the strongest peak (Hann window)."""
    if len(x) < 64:
        return 1.0
    power = np.abs(np.fft.rfft(x.astype(np.float64) * np.hanning(len(x)))) ** 2
    total = power.sum()
    if total <= 0:
        return 0.0
    k = int(np.argmax(power))
    half = max(2, round(half_width_hz * len(x) / RATE))
    return float(power[max(0, k - half) : k + half + 1].sum() / total)


def flatness_frames(x: np.ndarray, frame: int, hop: int, floor_dbfs: float) -> np.ndarray:
    """Spectral flatness (geometric / arithmetic mean of the power spectrum) of each active frame."""
    window = np.hanning(frame)
    out = []
    for start in range(0, max(len(x) - frame, 0) + 1, hop):
        seg = x[start : start + frame]
        if len(seg) < frame or to_db(np.sqrt((seg**2).mean())) <= floor_dbfs:
            continue
        p = np.abs(np.fft.rfft(seg * window)) ** 2 + 1e-20
        out.append(float(np.exp(np.log(p).mean()) / p.mean()))
    return np.array(out)


def spectrogram_db(x: np.ndarray, columns: int, bins: int = 256) -> np.ndarray:
    """(bins, columns) dB magnitudes, low frequencies at the bottom row index 0."""
    n_fft = 1024
    window = np.hanning(n_fft)
    centres = np.linspace(0, max(len(x) - n_fft, 0), columns).astype(int)
    pad = np.pad(x.astype(np.float64), (0, n_fft))
    mags = np.stack([np.abs(np.fft.rfft(pad[c : c + n_fft] * window)) for c in centres], axis=1)
    mags = mags[: n_fft // 2]  # drop Nyquist
    edges = np.linspace(0, mags.shape[0], bins + 1).astype(int)
    rows = np.stack([mags[a : max(b, a + 1)].max(axis=0) for a, b in itertools.pairwise(edges)])
    return to_db(rows / (n_fft / 4))
