"""transcribe: speech gate (VAD) first, then mlx-whisper with the filler prompt and drop rules (D-15)."""

import json

import pytest
from conftest import DATA, fixture_file, run_tool, validate

from vox_py import transcribe

# English list from packages/engine/src/text/fillers.ts (phase 02); the engine passes it as `fillers`.
FILLERS_EN = ["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "hm", "mm", "mhm"]


def recorded():
    return json.loads((DATA / "whisper-recorded.json").read_text())


def test_initial_prompt_is_built_from_the_filler_list():
    prompt = transcribe.build_initial_prompt(FILLERS_EN)
    tokens = [t.strip(" ,.").lower() for t in prompt.split(",")]
    for filler in FILLERS_EN:
        assert filler in tokens
    assert prompt[0].isupper() and prompt.endswith(".")


def test_no_fillers_means_no_initial_prompt():
    assert transcribe.build_initial_prompt([]) is None


def test_segments_over_no_speech_or_compression_limits_are_dropped():
    regions = [(0, 12000)]
    words, dropped = transcribe.filter_result(recorded(), regions)
    texts = [w["text"] for w in words]
    # Segment 1: no_speech_prob 0.81 > 0.6 → dropped. Segment 3: compression_ratio 2.41 > 2.4.
    assert "Thanks" not in texts and "watching!" not in texts
    assert not any(t.lower().startswith("yeah") for t in texts)
    # Segment 2 sits exactly on both limits (0.6 and 2.4): kept, limits are strict.
    assert texts == ["Hello", "there.", "So,", "um,", "the", "first", "point."]
    assert dropped == {"segments": 2, "words": 0}


def test_words_that_overlap_no_speech_region_are_dropped():
    # "So, um, the" (5000-6000 ms) lie in the gap between the two regions.
    regions = [(300, 900), (6100, 7300)]
    words, dropped = transcribe.filter_result(recorded(), regions)
    assert [w["text"] for w in words] == ["Hello", "there.", "first", "point."]
    assert dropped == {"segments": 2, "words": 3}


def test_word_times_are_clipped_to_the_speech_region_they_overlap():
    # Whisper starts the first word after a pause early and ends the last one late (seen on
    # speech-fillers.wav: "The" at 4000 ms, speech from 4194 ms), so times are clipped (D-21).
    regions = [(300, 900), (6100, 7300)]
    words, _ = transcribe.filter_result(recorded(), regions)
    by_text = {w["text"]: w for w in words}
    assert by_text["there."] == {"text": "there.", "startMs": 820, "endMs": 900}
    assert by_text["first"] == {"text": "first", "startMs": 6100, "endMs": 6400}
    # Its midpoint (6050 ms) was outside the region before clipping; the word is kept.


def test_a_sliver_of_overlap_under_40_ms_is_dropped():
    # "Hello" 400-820 overlaps [790, 7300] by 30 ms only; "there." overlaps fully.
    words, dropped = transcribe.filter_result(recorded(), [(790, 7300)])
    texts = [w["text"] for w in words]
    assert "Hello" not in texts and texts[0] == "there."
    assert dropped["words"] == 1


def test_a_short_word_inside_a_region_is_kept():
    result = {
        "segments": [
            {
                "no_speech_prob": 0.0,
                "compression_ratio": 1.0,
                "words": [{"word": " a", "start": 1.0, "end": 1.02}],
            }
        ]
    }
    words, dropped = transcribe.filter_result(result, [(900, 1100)])
    assert words == [{"text": "a", "startMs": 1000, "endMs": 1020}]
    assert dropped == {"segments": 0, "words": 0}


def test_words_are_integer_ms_and_stripped():
    words, _ = transcribe.filter_result(recorded(), [(0, 12000)])
    assert words[0] == {"text": "Hello", "startMs": 400, "endMs": 820}
    for w in words:
        assert isinstance(w["startMs"], int) and isinstance(w["endMs"], int)
        assert w["endMs"] >= w["startMs"]
        assert w["text"] == w["text"].strip() and w["text"]


def test_model_pin_is_a_full_commit_hash():
    assert transcribe.MODEL_REPO == "mlx-community/whisper-large-v3-turbo"
    assert len(transcribe.MODEL_REVISION) == 40
    int(transcribe.MODEL_REVISION, 16)


@pytest.mark.local
def test_speech_fillers_transcribes_with_word_timestamps():
    wav = fixture_file("speech-fillers.wav")
    request = {"audioPath": str(wav), "fillers": FILLERS_EN}
    validate("transcribe.request.json", request)
    code, result, stderr = run_tool("transcribe", request)
    assert code == 0, stderr
    validate("transcribe.result.json", result)
    assert result["language"] == "en"
    assert result["model"] == {
        "repo": transcribe.MODEL_REPO,
        "revision": transcribe.MODEL_REVISION,
    }
    words = result["words"]
    norm = [w["text"].strip(",.!?").lower() for w in words]
    for expected in ("think", "start", "first", "point", "simple", "works"):
        assert expected in norm, norm
    starts = [w["startMs"] for w in words]
    assert starts == sorted(starts)
    regions = result["speechRegions"]
    assert regions
    for w in words:  # every word lies inside one speech region (clipped)
        assert any(r["startMs"] <= w["startMs"] <= w["endMs"] <= r["endMs"] for r in regions), w
    # The sentence starts after a silence: its first word is kept, not lost to early timing.
    assert "the" in norm and "it" in norm, norm
    # Survival of fillers and the repeat is measured by the spike (GATE 1 item 8), not asserted;
    # print it for the phase log.
    fillers = [t for t in norm if t in FILLERS_EN]
    print(f"fillers kept: {fillers}; think x{norm.count('think')}; words: {norm}")


@pytest.mark.local
def test_no_words_survive_over_music_and_silence():
    wav = fixture_file("music-silence.wav")
    code, result, stderr = run_tool("transcribe", {"audioPath": str(wav), "fillers": FILLERS_EN})
    assert code == 0, stderr
    validate("transcribe.result.json", result)
    words = result["words"]
    assert words, "the spoken sentence was lost"
    for w in words:
        assert (w["startMs"] + w["endMs"]) / 2 >= 11900, w
    norm = [w["text"].strip(",.!?").lower() for w in words]
    assert "silence" in norm, norm
