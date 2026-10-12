"""ocr: Apple Vision text at 4 fps → caption words, position and case (styles Part C, phase 15)."""

import json

import pytest
from conftest import fixture_file, run_tool, stderr_error, validate

from vox_py import ocr


def line(text, x=0.3, y=0.7, w=0.4, h=0.05, conf=0.9):
    return {"text": text, "box": {"x": x, "y": y, "w": w, "h": h}, "confidence": conf}


# ---- pure helpers (fast tier) ----


def test_ocr_norm_drops_punctuation_and_case():
    assert ocr.norm("  Hello,   world! ") == "HELLO WORLD"


def test_ocr_letter_case():
    assert ocr.letter_case("MAPS TELL STORIES") == "upper"
    assert ocr.letter_case("maps tell") == "lower"
    assert ocr.letter_case("Maps Tell") == "asis"
    assert ocr.letter_case("1952") == "asis"


def test_ocr_static_text_is_left_out_of_captions():
    frames = [[line("@channel", x=0.4, y=0.05), line(f"word {i}")] for i in range(10)]
    static = ocr.static_texts(frames)
    assert static == {"CHANNEL"}
    events = ocr.caption_events(frames, 250, static)
    assert all("channel" not in e["text"] for e in events)


def test_ocr_off_centre_text_is_not_a_caption():
    assert ocr.caption_block([line("label", x=0.0, w=0.2)], set()) is None
    assert ocr.caption_block([line("centred")], set())["text"] == "centred"


def test_ocr_runs_of_the_same_text_are_one_caption_with_fuzzy_match():
    frames = [[line("EMPIRES RISE FAST")], [line("EMPIRES RISE FAS7")], [], [line("NEXT ONE")]]
    events = ocr.caption_events(frames, 250, set())
    assert [(e["text"], e["startMs"], e["endMs"]) for e in events] == [
        ("EMPIRES RISE FAST", 0, 500),
        ("NEXT ONE", 750, 1000),
    ]


def test_ocr_word_by_word_reveal_merges_into_one_caption():
    frames = [
        [line("THE")],
        [line("THE MAP")],
        [line("THE MAP CHANGED")],
        [line("THE MAP CHANGED")],
    ]
    events = ocr.caption_events(frames, 250, set())
    assert len(events) == 1
    assert events[0]["text"] == "THE MAP CHANGED"
    assert events[0]["reveal"] is True
    assert (events[0]["startMs"], events[0]["endMs"], events[0]["words"]) == (0, 1000, 3)


def test_ocr_summary_without_captions():
    assert ocr.summarise([]) == {"detected": False, "captionCount": 0}


def test_ocr_request_rejects_unknown_fields(tmp_path):
    video = tmp_path / "x.mp4"
    video.write_bytes(b"\0")
    code, _, err = run_tool("ocr", {"videoPath": str(video), "bogus": 1})
    assert code == 1
    assert stderr_error(err)["code"] == "INVALID_REQUEST"


# ---- the fixture video (local tier) ----


@pytest.fixture(scope="module")
def fixture_run():
    clip = fixture_file("style-extract-10s.mp4")
    truth = json.loads(fixture_file("style-extract-10s.truth.json").read_text())
    request = {"videoPath": str(clip)}
    validate("ocr.request.json", request)
    code, result, err = run_tool("ocr", request)
    assert code == 0, err
    return truth, result


@pytest.mark.local
def test_ocr_result_validates_against_its_schema(fixture_run):
    _, result = fixture_run
    validate("ocr.result.json", result)
    assert result["fps"] == 4
    assert len(result["frames"]) == 40


@pytest.mark.local
def test_ocr_finds_the_burnt_in_captions_with_timing_words_position_and_case(fixture_run):
    truth, result = fixture_run
    caps = result["captions"]
    assert [c["text"] for c in caps] == [c["text"] for c in truth["captions"]]
    for got, want in zip(caps, truth["captions"], strict=True):
        # 4 fps: each edge within one sample (250 ms) plus one for the sample length
        assert abs(got["startMs"] - want["startMs"]) <= 250
        assert abs(got["endMs"] - want["endMs"]) <= 500
    s = result["summary"]
    assert s["detected"] is True
    assert s["captionCount"] == 3
    assert s["wordsPerCaption"] == truth["wordsPerCaption"]
    assert s["case"] == truth["captionCase"]
    assert abs(s["yPct"] - truth["captionYPct"]) <= 2
    assert s["revealShare"] == 0
