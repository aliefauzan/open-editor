"""audioqa: measures cue timing, events, spacing, SFX under speech and loudness; kit checks (D-14, D-15).

The bad mixes come from `make.sh` (the `local` tier). The rest uses short synthetic signals written
into tmp_path, so the checks and the JSON protocol run on CI too.
"""

import json
import re
import struct
import subprocess
import wave
import zlib

import numpy as np
import pytest
from conftest import REPO_ROOT, SCHEMAS, fixture_file, run_tool, stderr_error, validate

from vox_py import audioqa_dsp as dsp

RATE = 48000
TAP = REPO_ROOT / "packages/engine/test/fixtures/assets/sfx/tap.wav"
CHECK_IDS = ["cueTiming", "oneEventPerCue", "spacing", "sfxUnderSpeech", "loudness"]


# ---- helpers ----


def write_wav(path, samples, channels=1):
    x = np.clip(np.asarray(samples, dtype=np.float64), -1, 1)
    pcm = (x * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return str(path)


def framed(x):
    """6 ms of digital silence on both sides: the first and last 5 ms of a clean sample are quiet."""
    pad = np.zeros(RATE * 6 // 1000)
    return np.concatenate([pad, x, pad])


def hit(duration_ms=120, amp=0.5, seed=1):
    """A short decaying noise burst with a 3 ms fade-in: a stand-in for a real SFX hit."""
    rng = np.random.default_rng(seed)
    n = RATE * duration_ms // 1000
    kernel = np.ones(8) / 8  # a little low-pass so it is not a flat noise burst
    x = np.convolve(rng.standard_normal(n), kernel, mode="same")
    x = x / np.abs(x).max()
    env = np.exp(-np.arange(n) / (RATE * 0.015))
    env[: RATE * 3 // 1000] *= np.linspace(0, 1, RATE * 3 // 1000)
    return amp * x * env


def stem(length_s, times_ms, sample):
    out = np.zeros(int(RATE * length_s))
    for t in times_ms:
        a = RATE * t // 1000
        out[a : a + len(sample)] += sample[: len(out) - a]
    return out


def tone(length_s, level_dbfs):
    t = np.arange(int(RATE * length_s)) / RATE
    return 10 ** (level_dbfs / 20) * np.sin(2 * np.pi * 440 * t)


def read_png(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, size = 8, b"", None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        tag = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        assert (
            zlib.crc32(tag + body)
            == struct.unpack(">I", data[pos + 8 + length : pos + 12 + length])[0]
        )
        if tag == b"IHDR":
            size = struct.unpack(">II", body[:8])
        if tag == b"IDAT":
            idat += body
        pos += 12 + length
    w, h = size
    raw = np.frombuffer(zlib.decompress(idat), dtype=np.uint8).reshape(h, 1 + w * 3)
    assert (raw[:, 0] == 0).all()
    return raw[:, 1:].reshape(h, w, 3)


def marker_runs(img, layout):
    """Count runs of the cue marker colours along the scan row of qa.png."""
    row = img[layout["markerScanY"]]
    is_marker = np.array([tuple(p) in {(255, 64, 64), (255, 64, 255)} for p in row])
    return int(((~np.concatenate([[False], is_marker[:-1]])) & is_marker).sum())


def run_mix(tmp_path, mix, sfx, speech, cues, fps=30, target=-14, name="out"):
    req = {
        "mix": mix,
        "stems": {"sfx": sfx, **({"speech": speech} if speech else {})},
        "cues": cues,
        "fps": fps,
        "target": target,
        "outDir": str(tmp_path / name),
    }
    validate("audioqa.request.json", req)
    code, result, stderr = run_tool("audioqa", req, timeout=300)
    assert code == 0, stderr
    validate("audioqa.result.json", result)
    return result


def failed(result):
    return [c["id"] for c in result["checks"] if c["status"] == "fail"]


def cue(at, kind="land", hero=False):
    return {"atMs": at, "type": kind, "hero": hero}


# ---- thresholds and DSP (fast) ----


def test_thresholds_file_holds_the_tolerance_not_the_target():
    th = json.loads((dsp.THRESHOLDS_PATH).read_text())
    assert th["checks"]["loudness"]["toleranceLu"] == 1
    assert th["checks"]["loudness"]["maxTruePeakDbtp"] == -1
    assert th["checks"]["spacing"]["minGapMs"] == 120
    assert th["checks"]["sfxUnderSpeech"]["minMarginLu"] == 6
    assert th["checks"]["cueTiming"]["toleranceFrames"] == 1
    assert (
        "target" not in json.dumps(th["checks"]).lower()
    )  # D-15: the target comes from the request


def test_loudness_and_true_peak_match_ffmpeg_ebur128(tmp_path):
    rng = np.random.default_rng(3)
    left = 0.1 * np.convolve(rng.standard_normal(RATE * 6), np.ones(4) / 4, mode="same")
    right = 0.4 * tone(6, -12) + 0.02 * rng.standard_normal(RATE * 6)
    path = write_wav(tmp_path / "s.wav", np.stack([left, right], axis=1).ravel(), channels=2)
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true",
         "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    summary = proc.stderr.split("Summary:")[1]
    ref_i = float(re.search(r"I:\s+(-?[\d.]+) LUFS", summary).group(1))
    ref_tp = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary).group(1))
    x = dsp.decode(tmp_path / "s.wav", "ffmpeg", "wav")
    hi = dsp.sample_peak_stream(tmp_path / "s.wav", "ffmpeg", "wav", 192000, 60)
    assert dsp.integrated_lufs(x) == pytest.approx(ref_i, abs=0.1)
    assert dsp.peak_dbtp(hi) == pytest.approx(ref_tp, abs=0.4)


def test_digital_silence_has_no_loudness():
    assert dsp.integrated_lufs(np.zeros((RATE * 2, 2), dtype=np.float32)) is None


def test_clipped_samples_counts_only_runs():
    x = np.zeros((1000, 1), dtype=np.float32)
    x[10] = 1.0  # one sample at full scale is not a clipped run
    x[100:110] = 1.0
    assert dsp.clipped_samples(x, 0.9997, 3) == 10


def test_onsets_find_hits_but_not_their_tails():
    cfg = dsp.load_thresholds()["analysis"]
    x = stem(3, [500, 1500, 1580], hit(200))
    ms = [o["ms"] for o in dsp.find_onsets(x, cfg)]
    assert len(ms) == 3
    assert all(abs(a - b) <= 4 for a, b in zip(ms, [500, 1500, 1580]))


def test_a_hit_30_db_under_the_loudest_is_still_an_onset():
    cfg = dsp.load_thresholds()["analysis"]
    x = stem(3, [500], hit(150, amp=0.9)) + stem(3, [1500], hit(150, amp=0.03))
    assert [round(o["ms"], -1) for o in dsp.find_onsets(x, cfg)] == [500, 1500]


def test_cue_claims_use_the_best_match_not_the_first_one():
    from vox_py import audioqa

    onsets = [{"ms": 1000}, {"ms": 1100}]
    cues = [{"index": 1, "atMs": 1040}, {"index": 2, "atMs": 1100}]  # cue 1 is nearer to onset 1000
    forward = audioqa.claim_onsets(cues, onsets, 250)
    assert forward == {1: 0, 2: 1}
    # Greedy matching in listed order could hand onset 1100 to cue 1 and leave cue 2 without one.
    raw = [
        {"atMs": 1100, "type": "cut", "hero": False},
        {"atMs": 1040, "type": "cut", "hero": False},
    ]
    # indexes follow the listed order; the match is by time
    assert audioqa.claim_onsets(audioqa.parse_cues(raw), onsets, 250) == {2: 0, 1: 1}
    assert audioqa.claim_onsets([{"index": 1, "atMs": 5000}], onsets, 250) == {}


def test_k_weighting_blocks_match_a_single_pass():
    x = np.random.default_rng(1).standard_normal((1 << 20) + 5000)
    whole = np.convolve(x[:3000], dsp._k_kernel())[:3000]
    blocks = dsp.k_weight(x)
    assert np.allclose(blocks[:3000], whole, atol=1e-9)
    assert len(blocks) == len(x) and np.isfinite(blocks).all()


def test_onsets_of_silence_and_empty():
    cfg = dsp.load_thresholds()["analysis"]
    assert dsp.find_onsets(np.zeros(RATE), cfg) == []
    assert dsp.find_onsets(np.zeros(0), cfg) == []


# ---- mix mode on synthetic audio (fast) ----


@pytest.fixture
def synth(tmp_path):
    """A 6 s case: speech-like tone 1.0-3.0 s, hits at 0.5, 2.0 (over speech) and 4.5 s."""
    sfx_times = [500, 2000, 4500]
    speech = np.where((np.arange(RATE * 6) >= RATE) & (np.arange(RATE * 6) < RATE * 3), 1.0, 0.0)
    speech = speech * tone(6, -20)

    def build(sfx_gain=0.05, times=sfx_times):
        sfx = stem(6, times, hit(150)) * sfx_gain
        mix = 0.5 * (speech + sfx)
        stereo = np.repeat(mix, 2)
        return {
            "lufs": round(dsp.integrated_lufs(np.stack([mix, mix], axis=1)), 1),
            "sfx": write_wav(tmp_path / "sfx.wav", sfx),
            "speech": write_wav(tmp_path / "speech.wav", speech),
            "mix": write_wav(tmp_path / "mix.wav", stereo, channels=2),
        }

    return build


def test_synthetic_case_passes_the_event_checks_and_writes_outputs(synth, tmp_path):
    files = synth()
    cues = [cue(500, "hero", True), cue(2000), cue(4500)]
    r = run_mix(tmp_path, files["mix"], files["sfx"], files["speech"], cues, target=files["lufs"])
    by = {c["id"]: c for c in r["checks"]}
    assert by["cueTiming"]["status"] == "pass" and by["oneEventPerCue"]["status"] == "pass"
    assert by["spacing"]["status"] == "pass" and by["sfxUnderSpeech"]["status"] == "pass"
    out = tmp_path / "out"
    assert (out / "qa.json").is_file() and (out / "LISTEN.md").is_file()
    assert json.loads((out / "qa.json").read_text())["checks"][0]["id"] == "cueTiming"
    img = read_png(out / "qa.png")
    assert img.shape == (r["png"]["height"], r["png"]["width"], 3)
    assert marker_runs(img, r["png"]) == len(cues)
    assert [m["cue"] for m in r["png"]["markers"]] == [1, 2, 3]


def test_a_late_hit_fails_only_cue_timing(synth, tmp_path):
    files = synth(times=[500, 2100, 4500])  # cue 2 is 3 frames late at 30 fps
    cues = [cue(500), cue(2000), cue(4500)]
    r = run_mix(tmp_path, files["mix"], files["sfx"], files["speech"], cues, target=files["lufs"])
    assert failed(r) == ["cueTiming"]
    row = r["checks"][0]["failures"][0]
    assert row["cue"] == 2 and 90 <= row["deltaMs"] <= 110


def test_one_frame_late_is_inside_the_tolerance(synth, tmp_path):
    files = synth(times=[500, 2030, 4500])  # 30 ms < 33.3 ms
    r = run_mix(tmp_path, files["mix"], files["sfx"], files["speech"],
                [cue(500), cue(2000), cue(4500)], target=files["lufs"])  # fmt: skip
    assert failed(r) == []


def test_missing_hit_fails_cue_timing(synth, tmp_path):
    files = synth(times=[500, 4500])
    r = run_mix(tmp_path, files["mix"], files["sfx"], files["speech"],
                [cue(500), cue(2000), cue(4500)], target=files["lufs"])  # fmt: skip
    assert failed(r) == ["cueTiming"]
    assert r["checks"][0]["failures"][0]["onsetMs"] is None


def test_loud_sfx_over_speech_fails_only_that_check(synth, tmp_path):
    files = synth(sfx_gain=2.0)
    r = run_mix(tmp_path, files["mix"], files["sfx"], files["speech"],
                [cue(500), cue(2000), cue(4500)], target=files["lufs"])  # fmt: skip
    assert failed(r) == ["sfxUnderSpeech"]
    assert [f["onsetMs"] for f in r["checks"][3]["failures"]] == [pytest.approx(2000, abs=15)]


def test_loudness_is_checked_against_the_requested_target(synth, tmp_path):
    files = synth()
    cues = [cue(500), cue(2000), cue(4500)]
    ok = run_mix(
        tmp_path, files["mix"], files["sfx"], files["speech"], cues, target=files["lufs"], name="a"
    )
    off = run_mix(tmp_path, files["mix"], files["sfx"], files["speech"], cues, target=-14, name="b")
    assert ok["checks"][4]["status"] == "pass"
    assert failed(off) == ["loudness"] and off["checks"][4]["parts"]["integrated"] == "fail"
    assert off["checks"][4]["deltaLu"] == pytest.approx(
        ok["checks"][4]["integratedLufs"] + 14, abs=0.1
    )


def test_true_peak_over_the_limit_fails_loudness(tmp_path):
    sfx = stem(3, [500], hit(100)) * 0.1
    mix = tone(3, -3)  # peaks at -3 dBFS: fine; then a +0.5 dBFS-ish inter-sample build below
    write_wav(tmp_path / "sfx.wav", sfx)
    loud = write_wav(tmp_path / "loud.wav", np.repeat(tone(3, -0.5), 2), channels=2)
    r = run_mix(tmp_path, loud, str(tmp_path / "sfx.wav"), None, [cue(500)], target=-3.5)
    assert r["checks"][4]["parts"]["truePeak"] == "fail"
    assert mix.max() < 1


def test_without_a_speech_stem_the_overlap_check_is_skipped(synth, tmp_path):
    files = synth()
    r = run_mix(tmp_path, files["mix"], files["sfx"], None,
                [cue(500), cue(2000), cue(4500)], target=files["lufs"])  # fmt: skip
    assert r["checks"][3]["status"] == "skipped"
    assert r["pass"] is True
    assert all(item["kind"] != "speech overlap" for item in r["listen"])


def test_listen_lists_hero_cues_first(synth, tmp_path):
    files = synth()
    cues = [cue(500, "hero", True), cue(2000), cue(4500, "hero", True)]
    r = run_mix(tmp_path, files["mix"], files["sfx"], files["speech"], cues, target=files["lufs"])
    kinds = [i["kind"] for i in r["listen"]]
    assert kinds[:2] == ["hero cue", "hero cue"]
    text = (tmp_path / "out" / "LISTEN.md").read_text()
    assert "00:00.500" in text and "00:04.500" in text
    assert "do not say the sound is good" in " ".join(text.split())


# ---- protocol ----


def test_relative_out_dir_is_refused(tmp_path):
    code, _, stderr = run_tool(
        "audioqa", {"mode": "kit", "styleId": "x", "files": [], "outDir": "rel"}
    )
    assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize("style", ["../evil", "a/b", ".hidden", ""])
def test_style_id_cannot_escape_the_out_dir(tmp_path, style):
    req = {"mode": "kit", "styleId": style, "outDir": str(tmp_path),
           "files": [{"path": str(TAP), "type": "cut"}]}  # fmt: skip
    code, _, stderr = run_tool("audioqa", req)
    assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST"
    assert not list(tmp_path.glob("**/*.png"))


def test_mix_mode_rejects_kit_fields_and_bad_cues(tmp_path):
    base = {"mix": str(TAP), "stems": {"sfx": str(TAP)}, "fps": 30, "target": -14,
            "outDir": str(tmp_path)}  # fmt: skip
    for extra in ({"cues": [], "styleId": "x"}, {"cues": [{"atMs": -1, "type": "cut", "hero": False}]},
                  {"cues": [{"atMs": 1, "type": "boom", "hero": False}]}, {"cues": [{"atMs": 1}]}):  # fmt: skip
        code, _, stderr = run_tool("audioqa", {**base, **extra})
        assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST", extra


def test_fps_outside_the_engine_range_is_refused(tmp_path):
    base = {"mix": str(TAP), "stems": {"sfx": str(TAP)}, "cues": [], "target": -14,
            "outDir": str(tmp_path)}  # fmt: skip
    for fps in (0.01, 12, 240):
        code, _, stderr = run_tool("audioqa", {**base, "fps": fps})
        assert code == 1 and stderr_error(stderr)["code"] == "INVALID_REQUEST", fps


def test_a_mix_longer_than_the_cap_is_refused(tmp_path, monkeypatch):
    th = dict(dsp.load_thresholds())
    th["analysis"] = {**th["analysis"], "maxMixSeconds": 1}
    monkeypatch.setattr(dsp, "load_thresholds", lambda: th)
    from vox_py import audioqa

    wav = write_wav(tmp_path / "long.wav", tone(3, -20))
    req = {"mix": wav, "stems": {"sfx": wav}, "cues": [], "fps": 30, "target": -14,
           "outDir": str(tmp_path / "o")}  # fmt: skip
    with pytest.raises(audioqa._tool.ToolError) as info:
        audioqa.handle(req)
    assert info.value.code == "INPUT_TOO_LONG"


def test_a_file_without_audio_is_unreadable(tmp_path):
    empty = write_wav(tmp_path / "empty.wav", np.zeros(0))
    req = {"mix": empty, "stems": {"sfx": empty}, "cues": [], "fps": 30, "target": -14,
           "outDir": str(tmp_path / "o")}  # fmt: skip
    code, _, stderr = run_tool("audioqa", req)
    assert code == 1 and stderr_error(stderr)["code"] == "MEDIA_UNREADABLE"


def test_missing_input_file_is_input_not_found(tmp_path):
    req = {"mix": str(tmp_path / "nope.wav"), "stems": {"sfx": str(TAP)}, "cues": [], "fps": 30,
           "target": -14, "outDir": str(tmp_path)}  # fmt: skip
    code, _, stderr = run_tool("audioqa", req)
    assert code == 1 and stderr_error(stderr)["code"] == "INPUT_NOT_FOUND"


def test_request_and_result_schemas_are_valid_json_schema():
    from jsonschema import Draft202012Validator

    for kind in ("request", "result"):
        Draft202012Validator.check_schema(
            json.loads((SCHEMAS / f"audioqa.{kind}.json").read_text())
        )


# ---- kit mode ----


def run_kit(tmp_path, files, style="test"):
    req = {"mode": "kit", "styleId": style, "files": files, "outDir": str(tmp_path / "kit")}
    validate("audioqa.request.json", req)
    code, result, stderr = run_tool("audioqa", req, timeout=300)
    assert code == 0, stderr
    validate("audioqa.result.json", result)
    return result


def kit_failures(result, index=0):
    return [c["id"] for c in result["files"][index]["checks"] if not c["pass"]]


def test_checked_in_tap_passes_the_kit_check_and_writes_the_sheet(tmp_path):
    r = run_kit(tmp_path, [{"path": str(TAP), "type": "cut"}])
    assert r["pass"] is True and kit_failures(r) == []
    sheet = tmp_path / "kit" / "kit-test.png"
    img = read_png(sheet)
    assert img.shape[1] == 1200 and img.shape[0] > 200
    assert (tmp_path / "kit" / "kit-test.json").is_file()
    assert tuple(img[2, 5]) == (0, 170, 90)  # the pass strip is green


def test_kit_sheet_marks_a_failing_file_red(tmp_path):
    beep = write_wav(tmp_path / "beep.wav", tone(0.3, -6))
    r = run_kit(tmp_path, [{"path": beep, "type": "appear"}, {"path": str(TAP), "type": "cut"}])
    img = read_png(tmp_path / "kit" / "kit-test.png")
    block = img.shape[0] // 2
    assert tuple(img[2, 5]) == (220, 50, 50) and tuple(img[block + 2, 5]) == (0, 170, 90)
    assert r["pass"] is False


def test_a_pure_tone_fails_not_synthesised(tmp_path):
    x = tone(0.3, -6)
    n = RATE * 20 // 1000
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    r = run_kit(tmp_path, [{"path": write_wav(tmp_path / "t.wav", framed(x)), "type": "appear"}])
    assert kit_failures(r) == ["notSynthesised"]


def test_steady_noise_fails_not_noise_bed(tmp_path):
    rng = np.random.default_rng(5)
    x = 0.2 * rng.standard_normal(RATE * 2)
    n = RATE * 20 // 1000
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    r = run_kit(tmp_path, [{"path": write_wav(tmp_path / "n.wav", framed(x)), "type": "land"}])
    assert kit_failures(r) == ["notNoiseBed"]


def test_a_click_at_the_first_sample_fails_clean_edges(tmp_path):
    x = hit(200, amp=0.5)
    x[: RATE * 3 // 1000] = 0.5 * np.sign(x[RATE * 3 // 1000])  # no fade-in: starts at -6 dBFS
    r = run_kit(tmp_path, [{"path": write_wav(tmp_path / "c.wav", x), "type": "cut"}])
    assert kit_failures(r) == ["cleanEdges"]


def test_two_hits_in_one_file_fail_one_event(tmp_path):
    x = stem(1, [6, 306], hit(150))
    r = run_kit(tmp_path, [{"path": write_wav(tmp_path / "d.wav", x), "type": "hero"}])
    assert kit_failures(r) == ["oneEvent"]
    assert r["files"][0]["checks"][1]["onsets"] == 2


def test_peak_and_length_limits(tmp_path):
    h = hit(150)
    hot = write_wav(tmp_path / "hot.wav", framed(0.97 * h / np.abs(h).max()))  # peak -0.26 dBFS
    long_x = np.convolve(
        np.random.default_rng(2).standard_normal(RATE * 4), np.ones(16) / 16, "same"
    )
    env = np.exp(-np.arange(len(long_x)) / (RATE * 0.3))
    long_x = 0.3 * long_x / np.abs(long_x).max() * env
    n = RATE * 5 // 1000
    long_x[:n] = 0  # silent first 5 ms
    long_x[-n:] = 0  # silent last 5 ms
    long_wav = write_wav(tmp_path / "long.wav", long_x)
    r = run_kit(tmp_path, [{"path": hot, "type": "cut"}, {"path": long_wav, "type": "land"}])
    assert kit_failures(r, 0) == ["peak"]
    assert kit_failures(r, 1) == ["length"]


def test_a_move_sound_may_swell(tmp_path):
    rng = np.random.default_rng(9)
    n = int(RATE * 1.2)
    noise = np.convolve(rng.standard_normal(n), np.ones(40) / 40, mode="same")  # dark whoosh
    env = np.sin(np.pi * np.arange(n) / n) ** 2
    x = framed(0.5 * noise / np.abs(noise).max() * env)
    r = run_kit(tmp_path, [{"path": write_wav(tmp_path / "m.wav", x), "type": "move"}])
    assert r["pass"] is True, [c for c in r["files"][0]["checks"] if not c["pass"]]


# ---- the make.sh set (local tier) ----

AUDIO = "audio/"


def fixture_request(tmp_path, case, name="out"):
    cues = json.loads(fixture_file(f"{AUDIO}{case}.cues.json").read_text())
    return {
        "mix": str(fixture_file(f"{AUDIO}{case}.wav")),
        "stems": {
            "sfx": str(fixture_file(f"{AUDIO}{case}.sfx.wav")),
            "speech": str(fixture_file(f"{AUDIO}{case}.speech.wav")),
        },
        "cues": cues["cues"],
        "fps": cues["fps"],
        "target": cues["target"],
        "outDir": str(tmp_path / name),
    }


def run_case(tmp_path, case):
    req = fixture_request(tmp_path, case)
    validate("audioqa.request.json", req)
    code, result, stderr = run_tool("audioqa", req, timeout=300)
    assert code == 0, stderr
    validate("audioqa.result.json", result)
    return result


@pytest.mark.local
def test_good_mix_passes_every_check_and_writes_the_outputs(tmp_path):
    r = run_case(tmp_path, "good")
    assert r["pass"] is True
    assert [c["id"] for c in r["checks"]] == CHECK_IDS
    assert all(c["status"] == "pass" for c in r["checks"]), r["checks"]
    loud = r["checks"][4]
    assert abs(loud["deltaLu"]) <= 1 and loud["truePeakDbtp"] <= -1 and loud["clippedSamples"] == 0
    assert r["checks"][0]["maxAbsDeltaMs"] <= 1000 / 30
    assert r["checks"][3]["minMarginLu"] >= 6

    out = tmp_path / "out"
    qa = json.loads((out / "qa.json").read_text())
    assert qa["checks"][4]["integratedLufs"] == loud["integratedLufs"]
    img = read_png(out / "qa.png")
    assert img.shape == (r["png"]["height"], r["png"]["width"], 3) == (416, 1600, 3)
    assert marker_runs(img, r["png"]) == len(r["cues"]) == 6

    listen = (out / "LISTEN.md").read_text()
    assert len(r["listen"]) == 5
    assert [i["kind"] for i in r["listen"]][:2] == ["hero cue", "hero cue"]
    assert len(re.findall(r"^\d\. `\d\d:\d\d\.\d\d\d`", listen, re.MULTILINE)) == 5


@pytest.mark.local
@pytest.mark.parametrize(
    ("case", "check"),
    [
        ("bad-late", "cueTiming"),
        ("bad-double-hit", "oneEventPerCue"),
        ("bad-close-cues", "spacing"),
        ("bad-sfx-over-speech", "sfxUnderSpeech"),
        ("bad-clipped", "loudness"),
    ],
)
def test_each_bad_mix_fails_exactly_its_own_check(tmp_path, case, check):
    r = run_case(tmp_path, case)
    assert failed(r) == [check], r["checks"]
    assert r["pass"] is False


@pytest.mark.local
def test_bad_mix_numbers(tmp_path):
    late = run_case(tmp_path, "bad-late")["checks"][0]["failures"]
    assert [f["cue"] for f in late] == [3] and 100 <= late[0][
        "deltaMs"
    ] <= 125  # 3 frames + the tap's lead-in
    double = run_case(tmp_path, "bad-double-hit")["checks"][1]["failures"]
    assert len(double) == 1 and double[0]["afterCue"] == 3 and 6000 <= double[0]["onsetMs"] <= 6100
    close = run_case(tmp_path, "bad-close-cues")["checks"][2]["failures"]
    assert len(close) == 1 and 45 <= close[0]["gapMs"] <= 55
    loud = run_case(tmp_path, "bad-sfx-over-speech")["checks"][3]
    assert 0 < len(loud["failures"]) <= 3 and loud["minMarginLu"] < 6
    clipped = run_case(tmp_path, "bad-clipped")["checks"][4]
    assert clipped["parts"]["clipping"] == "fail" and clipped["clippedSamples"] > 100


@pytest.mark.local
@pytest.mark.parametrize(
    ("name", "kind", "rule"),
    [
        ("kit-beep", "appear", "notSynthesised"),
        ("kit-noise-bed", "land", "notNoiseBed"),
        ("kit-click-start", "cut", "cleanEdges"),
        ("kit-double-hit", "hero", "oneEvent"),
    ],
)
def test_each_bad_kit_sample_fails_its_own_rule(tmp_path, name, kind, rule):
    r = run_kit(tmp_path, [{"path": str(fixture_file(f"{AUDIO}{name}.wav")), "type": kind}])
    assert kit_failures(r) == [rule], r["files"][0]["checks"]
