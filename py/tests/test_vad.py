"""vad: Silero VAD through onnxruntime, vendored model with a SHA-256 check (D-15)."""

import hashlib
import itertools
import shutil

import numpy as np
import pytest
from conftest import PY_ROOT, REPO_ROOT, fixture_file, run_tool, stderr_error, validate

from vox_py import _tool, vad

MODEL = PY_ROOT / "vox_py" / "models" / "silero_vad.onnx"


def test_vendored_model_matches_pinned_sha256():
    assert hashlib.sha256(MODEL.read_bytes()).hexdigest() == vad.MODEL_SHA256


def test_pinned_sha256_is_recorded_in_r5():
    r5 = REPO_ROOT / "plan" / "ref" / "R5-pins.md"
    if not r5.is_file():
        pytest.skip("plan/ folder not present (packaged py/ without the repo)")
    assert vad.MODEL_SHA256 in r5.read_text()


def test_vendored_model_ships_with_its_mit_licence():
    licence = (PY_ROOT / "vox_py" / "models" / "LICENSE.silero").read_text()
    assert "MIT License" in licence and "Silero" in licence


def test_changed_model_file_fails_the_hash_check(tmp_path):
    bad = tmp_path / "silero_vad.onnx"
    shutil.copy(MODEL, bad)
    with open(bad, "r+b") as fh:
        fh.seek(1000)
        byte = fh.read(1)
        fh.seek(1000)
        fh.write(bytes([byte[0] ^ 0xFF]))
    with pytest.raises(_tool.ToolError) as info:
        vad.load_model(bad)
    assert info.value.code == "MODEL_HASH_MISMATCH"


def test_silence_has_no_speech_regions():
    regions = vad.speech_regions(np.zeros(16000 * 3, dtype=np.float32))
    assert regions == []


def test_white_noise_has_no_speech_regions():
    rng = np.random.default_rng(7)
    noise = (rng.standard_normal(16000 * 3) * 0.05).astype(np.float32)
    assert vad.speech_regions(noise) == []


def test_regions_are_padded_merged_and_clamped():
    # Pure post-processing of per-window probabilities (512-sample windows at 16 kHz = 32 ms).
    probs = [0.0] * 10 + [0.9] * 20 + [0.0] * 3 + [0.9] * 20 + [0.0] * 40
    total = len(probs) * 512
    regions = vad.regions_from_probs(probs, total)
    # The 3-window (96 ms) dip is shorter than minSilenceMs (100 ms), so one region.
    assert len(regions) == 1
    start, end = regions[0]
    assert start == 10 * 512 - 480  # 30 ms pad
    assert end == 53 * 512 + 480


def test_close_regions_split_the_gap_and_far_regions_get_full_pads():
    # A 6-window gap (192 ms > minSilenceMs 100 ms) ends a region; the gap is 3072 samples.
    close = [0.9] * 20 + [0.0] * 6 + [0.9] * 20 + [0.0] * 10
    regions = vad.regions_from_probs(close, len(close) * 512, speech_pad_ms=200)
    assert len(regions) == 2
    gap = 26 * 512 - 20 * 512
    # pad 200 ms = 3200 samples: the gap is under 2 x pad, so each side takes half of it.
    assert regions[0][1] == 20 * 512 + gap // 2 and regions[1][0] == 26 * 512 - gap // 2
    # pad 30 ms = 480 samples: the gap is over 2 x pad, so each side gets the full pad.
    far = vad.regions_from_probs(close, len(close) * 512, speech_pad_ms=30)
    assert far[0][1] == 20 * 512 + 480 and far[1][0] == 26 * 512 - 480


def test_short_blips_are_not_speech():
    probs = [0.0] * 10 + [0.9] * 3 + [0.0] * 40  # 96 ms < minSpeechMs 250
    assert vad.regions_from_probs(probs, len(probs) * 512) == []


@pytest.mark.local
def test_music_silence_regions_cover_only_the_spoken_sentence():
    wav = fixture_file("music-silence.wav")
    request = {"audioPath": str(wav)}
    validate("vad.request.json", request)
    code, result, stderr = run_tool("vad", request)
    assert code == 0, stderr
    validate("vad.result.json", result)
    regions = result["speechRegions"]
    assert result["durationMs"] > 12000
    assert regions, "no speech found in the spoken sentence"
    # 8 s music + 4 s silence: no region may start before the sentence (pad allowed).
    assert all(r["startMs"] >= 11900 for r in regions), regions
    assert all(r["endMs"] <= result["durationMs"] for r in regions)
    covered = sum(r["endMs"] - r["startMs"] for r in regions)
    assert covered >= 1200, regions
    assert result["model"]["sha256"] == vad.MODEL_SHA256


@pytest.mark.local
def test_speech_fillers_regions_split_at_the_long_silence():
    wav = fixture_file("speech-fillers.wav")
    code, result, stderr = run_tool("vad", {"audioPath": str(wav)})
    assert code == 0, stderr
    regions = result["speechRegions"]
    assert len(regions) >= 2, regions
    gaps = [b["startMs"] - a["endMs"] for a, b in itertools.pairwise(regions)]
    assert max(gaps) >= 400, regions  # the 600 ms [[slnc 600]]


def test_concat_list_disguised_as_media_is_refused(tmp_path):
    # S5: the demuxer whitelist (no concat, no hls) and file,pipe protocols only.
    secret = tmp_path / "secret.wav"
    secret.write_bytes(b"RIFF")
    fake = tmp_path / "clip.mp4"
    fake.write_text(f"ffconcat version 1.0\nfile '{secret}'\n")
    code, _, stderr = run_tool("vad", {"audioPath": str(fake)})
    assert code == 1
    err = stderr_error(stderr)
    assert err["code"] == "MEDIA_UNREADABLE" and "whitelist" in err["message"]
