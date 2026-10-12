"""transcribe (D-79): Whisper hears padded, merged speech spans; times map back to source time."""

import sys
import types

import numpy as np
import pytest

from vox_py import transcribe, vad

SR = vad.SAMPLE_RATE
PAD = transcribe.REGION_PAD_MS
GAP = transcribe.REGION_MERGE_GAP_MS


def tones(duration_ms: int, bursts: list[tuple[int, int]]) -> np.ndarray:
    """Silence with a constant non-zero signal in each `(startMs, endMs)` burst."""
    audio = np.zeros(duration_ms * SR // 1000, dtype=np.float32)
    for start, end in bursts:
        audio[start * SR // 1000 : end * SR // 1000] = 0.5
    return audio


def fake_whisper(calls: list[int]):
    """A stand-in for mlx-whisper: one word per non-zero run of the audio it hears."""

    def run(samples: np.ndarray, **_: object) -> dict:
        calls.append(len(samples))
        on = np.concatenate([[0], (np.abs(samples) > 0).astype(np.int8), [0]])
        edges = np.flatnonzero(np.diff(on))
        words = [
            {"word": f" w{i}", "start": s / SR, "end": e / SR, "probability": 1.0}
            for i, (s, e) in enumerate(zip(edges[::2], edges[1::2], strict=True))
        ]
        segments = [
            {
                "start": w["start"],
                "end": w["end"],
                "no_speech_prob": 0.0,
                "compression_ratio": 1.0,
                "words": [w],
            }
            for w in words
        ]
        return {"language": "en", "segments": segments}

    return run


def region(start: int, end: int) -> dict[str, int]:
    return {"startMs": start, "endMs": end}


# ---- planning ----


def test_regions_are_padded_and_close_ones_merged():
    regions = [region(10_000, 11_000), region(11_000 + 2 * PAD + GAP - 1, 13_000)]
    spans = transcribe.plan_spans(regions, 60_000)
    assert spans == [(10_000 - PAD, 13_000 + PAD)]
    regions[1] = region(11_000 + 2 * PAD + GAP, 13_000)
    spans = transcribe.plan_spans(regions, 60_000)
    assert spans == [(10_000 - PAD, 11_000 + PAD), (11_000 + PAD + GAP, 13_000 + PAD)]


def test_spans_are_clamped_at_file_start_and_end():
    spans = transcribe.plan_spans([region(100, 400), region(59_800, 60_000)], 60_000)
    assert spans == [(0, 400 + PAD), (59_800 - PAD, 60_000)]


def test_very_short_region_gets_full_padding():
    spans = transcribe.plan_spans([region(30_000, 30_040)], 60_000)
    assert spans == [(30_000 - PAD, 30_040 + PAD)]


def test_dense_speech_or_no_regions_means_whole_file():
    assert transcribe.plan_spans([], 60_000) is None
    assert transcribe.plan_spans([region(0, 1000)], 0) is None
    dense = [region(0, 27_000), region(30_000, 57_000)]  # spans keep over 90 %
    assert transcribe.plan_spans(dense, 60_000) is None


# ---- offset map ----


def test_offsets_map_back_exactly():
    m = transcribe.OffsetMap([(0, 1000), (5000, 6000), (9000, 9500)])
    assert m.total_ms == 2500
    assert m.to_source(0.0) == 0.0
    assert m.to_source(0.5) == 0.5
    assert m.to_source(1.5) == 5.5
    assert m.to_source(2.25) == 9.25
    # A seam: a start belongs to the span after it, an end to the span before it.
    assert m.to_source(1.0) == 5.0
    assert m.to_source(1.0, end=True) == 1.0
    assert m.to_source(2.0, end=True) == 6.0
    # Past the joined audio clamps to the last span's end.
    assert m.to_source(2.6, end=True) == 9.5
    assert m.to_source(2.6) == 9.5


def test_map_result_moves_segments_and_words():
    m = transcribe.OffsetMap([(2000, 3000), (8000, 9000)])
    result = {
        "language": "en",
        "segments": [
            {
                "start": 0.5,
                "end": 1.0,
                "no_speech_prob": 0.1,
                "words": [{"word": " a", "start": 0.5, "end": 1.0}],
            },
            {
                "start": 1.0,
                "end": 1.6,
                "no_speech_prob": 0.1,
                "words": [{"word": " b", "start": 1.2, "end": 1.6}],
            },
        ],
    }
    out = m.map_result(result)
    assert out["language"] == "en"
    assert [(s["start"], s["end"]) for s in out["segments"]] == [(2.5, 3.0), (8.0, 8.6)]
    words = [(w["word"], w["start"], w["end"]) for s in out["segments"] for w in s["words"]]
    assert words == [(" a", 2.5, 3.0), (" b", 8.2, 8.6)]
    assert result["segments"][0]["start"] == 0.5  # the input is not changed


# ---- whisper on spans (fake model) ----

BURSTS = [(0, 300), (8000, 8100), (19_700, 20_000)]  # file start, very short, file end


def test_words_land_on_their_source_times():
    audio = tones(20_000, BURSTS)
    spans = transcribe.plan_spans([region(s, e) for s, e in BURSTS], 20_000)
    assert spans == [(0, 300 + PAD), (8000 - PAD, 8100 + PAD), (19_700 - PAD, 20_000)]
    calls: list[int] = []
    result = transcribe.transcribe_speech(audio, spans, fake_whisper(calls))
    assert calls == [sum(e - s for s, e in spans) * SR // 1000]  # Whisper heard only the spans
    words, dropped = transcribe.filter_result(result, BURSTS)
    assert [(w["startMs"], w["endMs"]) for w in words] == BURSTS
    assert dropped == {"segments": 0, "words": 0}


def test_whole_file_path_gives_the_same_words():
    audio = tones(20_000, BURSTS)
    calls: list[int] = []
    result = transcribe.transcribe_speech(audio, None, fake_whisper(calls))
    assert calls == [len(audio)]
    words, _ = transcribe.filter_result(result, BURSTS)
    assert [(w["startMs"], w["endMs"]) for w in words] == BURSTS


# ---- handle (model, decode and VAD stubbed) ----


@pytest.fixture
def stubbed(tmp_path, monkeypatch):
    """Runs `transcribe.handle` with a fake model dir, synthetic audio and a fake mlx_whisper."""
    media = tmp_path / "a.wav"
    media.write_bytes(b"x")
    calls: list[int] = []
    state: dict = {"audio": tones(20_000, BURSTS), "regions": None}
    fake = types.ModuleType("mlx_whisper")
    fake.transcribe = fake_whisper(calls)
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    monkeypatch.setattr(transcribe, "resolve_model", lambda _: tmp_path)
    monkeypatch.setattr(vad, "load_model", lambda: None)
    monkeypatch.setattr(vad, "decode_audio", lambda *_: state["audio"])

    def regions(_audio, _model):
        if isinstance(state["regions"], Exception):
            raise state["regions"]
        return state["regions"]

    monkeypatch.setattr(vad, "speech_regions", regions)

    def run():
        return transcribe.handle({"audioPath": str(media), "fillers": ["um"]})

    return state, calls, run


def test_handle_maps_span_words_to_source_time(stubbed):
    state, calls, run = stubbed
    state["regions"] = [region(s, e) for s, e in BURSTS]
    out = run()
    assert len(calls) == 1 and calls[0] < len(state["audio"])
    assert [(w["startMs"], w["endMs"]) for w in out["words"]] == BURSTS
    assert out["speechRegions"] == state["regions"]


def test_handle_silence_only_never_runs_whisper(stubbed):
    state, calls, run = stubbed
    state["audio"] = np.zeros(10 * SR, dtype=np.float32)
    state["regions"] = []
    out = run()
    assert calls == []
    assert out["words"] == [] and out["speechRegions"] == []


def test_handle_vad_failure_transcribes_the_whole_file(stubbed):
    state, calls, run = stubbed
    state["regions"] = RuntimeError("onnx failed")
    out = run()
    assert calls == [len(state["audio"])]
    assert out["speechRegions"] == [region(0, 20_000)]
    assert [(w["startMs"], w["endMs"]) for w in out["words"]] == BURSTS


def test_real_vad_finds_no_speech_in_silence():
    assert vad.speech_regions(np.zeros(5 * SR, dtype=np.float32)) == []
