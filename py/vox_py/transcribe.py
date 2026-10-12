"""Speech gate, then mlx-whisper with word timestamps (engine "Speech gate and word kinds", D-15).

Run as `python -I -m vox_py.transcribe`. Request: `{ audioPath, language?, fillers?, modelPath?,
ffmpeg?, formatWhitelist? }`. Result: `{ language, words: {text, startMs, endMs}[],
speechRegions, dropped: {segments, words}, model: {repo, revision} }`.

- Silero VAD (`vox_py.vad`) finds the speech regions first. No speech → Whisper is not run.
- Whisper hears only the speech (D-79): each region is padded by `REGION_PAD_MS`, regions closer
  than `REGION_MERGE_GAP_MS` are merged, the spans are joined into one audio buffer and every
  segment/word time is mapped back to source time through the span offsets. When the spans keep at
  least `WHOLE_FILE_SHARE` of the file (dense speech, so little to save), or the VAD itself fails,
  Whisper hears the whole file as before.
- Whisper gets an `initial_prompt` built from `fillers` (the engine passes the English list from
  `engine/src/text/fillers.ts`), so it keeps more hesitation words.
- Segments with `no_speech_prob > 0.6` or `compression_ratio > 2.4` are dropped whole. Each word is
  clipped to the speech region it overlaps most; a word that overlaps no region (by at least 40 ms,
  or its whole length if shorter) is dropped.
- Word kinds and pause pseudo-words are computed by the engine (`computeWordKinds`), never here.

The model is `MODEL_REPO` at the pinned commit `MODEL_REVISION`; without `modelPath` it is fetched
into the Hugging Face cache on first use, and the weights file is checked against its SHA-256.
"""

from __future__ import annotations

import os
from bisect import bisect_left, bisect_right
from collections.abc import Callable
from pathlib import Path

import numpy as np

from . import _tool, vad

MODEL_REPO = "mlx-community/whisper-large-v3-turbo"
MODEL_REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"
MODEL_WEIGHTS = "weights.safetensors"
MODEL_WEIGHTS_SHA256 = "951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6"

NO_SPEECH_PROB_MAX = 0.6
COMPRESSION_RATIO_MAX = 2.4
MIN_OVERLAP_MS = 40

# D-79: Whisper hears padded, merged speech spans instead of the whole file.
REGION_PAD_MS = (
    400  # context on each side of a VAD region; covers Whisper's early first word (D-21)
)
REGION_MERGE_GAP_MS = 500  # padded spans closer than this are joined (a short cut saves nothing)
WHOLE_FILE_SHARE = 0.9  # spans keeping at least this share of the file → whole file, as before
SAMPLES_PER_MS = vad.SAMPLE_RATE // 1000

REQUEST: _tool.Spec = {
    "audioPath": (str, True),
    "language": ((str, type(None)), False),
    "fillers": (list, False),
    "modelPath": (str, False),
    "ffmpeg": (str, False),
    "formatWhitelist": (str, False),
}


def build_initial_prompt(fillers: list[str]) -> str | None:
    """`"Um, umm, uh, …, mhm."` from the filler list (order kept, duplicates removed)."""
    words = list(dict.fromkeys(f.strip() for f in fillers if f.strip()))
    if not words:
        return None
    text = ", ".join(words) + "."
    return text[0].upper() + text[1:]


def _ms(seconds: float) -> int:
    return max(0, round(seconds * 1000))


def _best_region(start: int, end: int, regions: list[tuple[int, int]]) -> tuple[int, int] | None:
    """The region that overlaps [start, end] most, if the overlap is long enough to count."""
    best, best_overlap = None, float("-inf")
    for a, b in regions:
        overlap = min(end, b) - max(start, a)  # negative when apart, 0 when touching
        if overlap > best_overlap:
            best, best_overlap = (a, b), overlap
    if best is None or best_overlap < min(MIN_OVERLAP_MS, end - start):
        return None
    return best


def filter_result(
    result: dict, regions: list[tuple[int, int]]
) -> tuple[list[dict], dict[str, int]]:
    """Apply the drop rules to an mlx-whisper result; returns raw words and drop counts.

    Segments over the `no_speech_prob` / `compression_ratio` limits are dropped whole. Each word is
    clipped to the speech region it overlaps most, so its midpoint lies inside that region; a word
    that overlaps no region by at least `MIN_OVERLAP_MS` (or its whole length, if shorter) is
    dropped. Whisper's first word after a pause often starts a few hundred ms early (D-21).
    """
    words: list[dict] = []
    dropped = {"segments": 0, "words": 0}
    for seg in result.get("segments", []):
        if (
            seg.get("no_speech_prob", 0.0) > NO_SPEECH_PROB_MAX
            or seg.get("compression_ratio", 0.0) > COMPRESSION_RATIO_MAX
        ):
            dropped["segments"] += 1
            continue
        for w in seg.get("words", []):
            text = w.get("word", "").strip()
            if not text:
                continue
            start = _ms(w["start"])
            end = max(_ms(w["end"]), start)
            region = _best_region(start, end, regions)
            if region is None:
                dropped["words"] += 1
                continue
            start, end = max(start, region[0]), min(end, region[1])
            words.append({"text": text, "startMs": start, "endMs": max(end, start)})
    words.sort(key=lambda w: (w["startMs"], w["endMs"]))
    return words, dropped


def plan_spans(regions: list[dict[str, int]], duration_ms: int) -> list[tuple[int, int]] | None:
    """Padded, merged `(startMs, endMs)` spans Whisper should hear, or None for the whole file.

    Each region grows by `REGION_PAD_MS` on both sides (clamped to the file); spans that overlap or
    lie less than `REGION_MERGE_GAP_MS` apart are merged. None when there is nothing to cut: no
    regions, or the spans keep at least `WHOLE_FILE_SHARE` of the file.
    """
    if not regions or duration_ms <= 0:
        return None
    spans: list[list[int]] = []
    for r in sorted(regions, key=lambda r: (r["startMs"], r["endMs"])):
        start = max(0, r["startMs"] - REGION_PAD_MS)
        end = min(duration_ms, r["endMs"] + REGION_PAD_MS)
        if end <= start:
            continue
        if spans and start - spans[-1][1] < REGION_MERGE_GAP_MS:
            spans[-1][1] = max(spans[-1][1], end)
        else:
            spans.append([start, end])
    kept = sum(e - s for s, e in spans)
    if not spans or kept >= WHOLE_FILE_SHARE * duration_ms:
        return None
    return [(s, e) for s, e in spans]


class OffsetMap:
    """Maps times in the joined span audio back to source times (seconds in, seconds out).

    Span k of the joined audio starts at `joined[k]` and came from source `[src_start, src_end]`
    ms. Spans are whole ms, so each shift is an exact whole number of ms. A start time on a seam
    belongs to the span after it; an end time on a seam belongs to the span before it, so a word
    that ends where a span ends keeps that end instead of jumping across the removed silence.
    """

    def __init__(self, spans: list[tuple[int, int]]):
        self.spans = spans
        self.joined: list[int] = []
        at = 0
        for start, end in spans:
            self.joined.append(at)
            at += end - start
        self.total_ms = at

    def _span(self, t_ms: float, end: bool) -> int:
        find = bisect_left if end else bisect_right
        return min(max(find(self.joined, t_ms) - 1, 0), len(self.spans) - 1)

    def to_source(self, t: float, end: bool = False) -> float:
        t_ms = t * 1000
        k = self._span(t_ms, end)
        start, stop = self.spans[k]
        offset = min(max(t_ms - self.joined[k], 0.0), stop - start)
        return (start + offset) / 1000

    def map_result(self, result: dict) -> dict:
        """A copy of an mlx-whisper result with every segment and word time in source time."""
        segments = []
        for seg in result.get("segments", []):
            seg = dict(seg)
            if "start" in seg:
                seg["start"] = self.to_source(seg["start"])
            if "end" in seg:
                seg["end"] = self.to_source(seg["end"], end=True)
            words = []
            for w in seg.get("words", []):
                w = dict(w)
                w["start"] = self.to_source(w["start"])
                w["end"] = self.to_source(w["end"], end=True)
                words.append(w)
            if "words" in seg:
                seg["words"] = words
            segments.append(seg)
        return {**result, "segments": segments}


def join_spans(audio: np.ndarray, spans: list[tuple[int, int]]) -> np.ndarray:
    """The samples of each span, back to back (16 kHz, so 16 samples per ms)."""
    return np.concatenate(
        [audio[s * SAMPLES_PER_MS : e * SAMPLES_PER_MS] for s, e in spans]
    ).astype(np.float32, copy=False)


def transcribe_speech(
    audio: np.ndarray,
    spans: list[tuple[int, int]] | None,
    whisper: Callable[[np.ndarray], dict],
) -> dict:
    """Run `whisper` on the spans joined (None: the whole file); the result is in source time."""
    if spans is None:
        return whisper(audio)
    return OffsetMap(spans).map_result(whisper(join_spans(audio, spans)))


def resolve_model(model_path: str | None) -> Path:
    if model_path:
        path = Path(model_path)
        if not (path / "config.json").is_file():
            raise _tool.ToolError("MODEL_MISSING", f"no Whisper model at {model_path}")
    else:
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        from huggingface_hub import snapshot_download

        try:
            path = Path(snapshot_download(repo_id=MODEL_REPO, revision=MODEL_REVISION))
        except Exception as exc:  # network or cache failure
            raise _tool.ToolError(
                "MODEL_MISSING", f"cannot fetch {MODEL_REPO}@{MODEL_REVISION}: {exc}"
            ) from exc
    weights = path / MODEL_WEIGHTS
    if not weights.is_file():
        raise _tool.ToolError("MODEL_MISSING", f"no {MODEL_WEIGHTS} in {path}")
    _tool.check_sha256(weights, MODEL_WEIGHTS_SHA256, "Whisper weights")
    return path


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    fillers = req.get("fillers", [])
    if not all(isinstance(f, str) and f for f in fillers):
        raise _tool.ToolError("INVALID_REQUEST", "fillers must be non-empty strings")
    language = req.get("language")
    path = _tool.existing_file(req["audioPath"])
    model_dir = resolve_model(req.get("modelPath"))
    gate = vad.load_model()

    _tool.progress(0.0, "decoding audio")
    audio = vad.decode_audio(
        path,
        req.get("ffmpeg", "ffmpeg"),
        req.get("formatWhitelist", _tool.DEFAULT_FORMAT_WHITELIST),
    )
    _tool.progress(0.05, "speech gate")
    try:
        regions = vad.speech_regions(audio, gate)
    except Exception as exc:  # noqa: BLE001 - VAD failed: no gate, the whole file is speech
        _tool.progress(0.05, f"speech gate failed ({type(exc).__name__}); using the whole file")
        regions = [{"startMs": 0, "endMs": vad.to_ms(len(audio))}] if len(audio) else []
    model = {"repo": MODEL_REPO, "revision": MODEL_REVISION}
    if not regions:
        _tool.progress(1.0, "no speech found")
        return {
            "language": language or "und",
            "words": [],
            "speechRegions": [],
            "dropped": {"segments": 0, "words": 0},
            "model": model,
        }

    import mlx_whisper

    def whisper(samples: np.ndarray) -> dict:
        return mlx_whisper.transcribe(
            samples,
            path_or_hf_repo=str(model_dir),
            language=language,
            word_timestamps=True,
            initial_prompt=build_initial_prompt(fillers),
            verbose=None,
        )

    spans = plan_spans(regions, vad.to_ms(len(audio)))
    if spans is None:
        _tool.progress(0.1, "transcribing")
    else:
        kept = sum(e - s for s, e in spans) / 1000
        _tool.progress(0.1, f"transcribing {len(spans)} speech spans ({kept:.1f} s)")
    result = transcribe_speech(audio, spans, whisper)
    words, dropped = filter_result(result, [(r["startMs"], r["endMs"]) for r in regions])
    _tool.progress(1.0, "done")
    return {
        "language": result.get("language") or language or "und",
        "words": words,
        "speechRegions": regions,
        "dropped": dropped,
        "model": model,
    }


if __name__ == "__main__":
    _tool.main(handle)
