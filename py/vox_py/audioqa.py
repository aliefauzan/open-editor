"""Audio QA (engine "Audio QA", plan D-14, D-15): measures a mix and its stems, or checks an SFX kit.

Run as `python -I -m vox_py.audioqa`. The engine cannot hear, so this reports numbers, a picture and
five timecodes for a person to listen to; it never says the sound is good.

Mix request: `{ mode?: "mix", mix, stems: { sfx, speech? }, cues: [{ atMs, type, hero }], fps, target,
outDir, ffmpeg?, formatWhitelist? }`. `target` is the loudness target in LUFS (the engine maps the
`--loudness` preset to it). Writes `qa.json`, `qa.png`, `LISTEN.md` into `outDir` and returns the
`qa.json` content.

Kit request: `{ mode: "kit", styleId, files: [{ path, type }], outDir, ffmpeg?, formatWhitelist? }`
(styles spec "SFX rules"). Writes `kit-<styleId>.json` and `kit-<styleId>.png`.

Limits live in `audioqa_thresholds.json` and are never loosened to make a check pass (R3).
"""

from __future__ import annotations

import bisect
import itertools
import json
import os
import re
from pathlib import Path

import numpy as np

from . import _tool
from . import audioqa_dsp as dsp
from . import audioqa_render as render

CUE_TYPES = ("cut", "move", "land", "appear", "hero")
NOTE = (
    "Measurements only. They do not say the sound is good: a person has to listen to the "
    "timecodes in LISTEN.md."
)

REQUEST: _tool.Spec = {
    "mode": (str, False),
    "outDir": (str, True),
    "ffmpeg": (str, False),
    "formatWhitelist": (str, False),
    "mix": (str, False),
    "stems": (dict, False),
    "cues": (list, False),
    "fps": ((int, float), False),
    "target": ((int, float), False),
    "styleId": (str, False),
    "files": (list, False),
}


def _r(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


# ---- mix mode ----


def parse_cues(raw: list) -> list[dict]:
    cues = []
    for i, c in enumerate(raw, 1):
        if not isinstance(c, dict) or set(c) != {"atMs", "type", "hero"}:
            raise _tool.ToolError("INVALID_REQUEST", f"cue {i} must be {{atMs, type, hero}}")
        at, ty, hero = c["atMs"], c["type"], c["hero"]
        if isinstance(at, bool) or not isinstance(at, int) or at < 0:
            raise _tool.ToolError("INVALID_REQUEST", f"cue {i}: atMs must be an integer >= 0")
        if ty not in CUE_TYPES or not isinstance(hero, bool):
            raise _tool.ToolError("INVALID_REQUEST", f"cue {i}: bad type or hero flag")
        cues.append({"index": i, "atMs": at, "type": ty, "hero": hero})
    return sorted(cues, key=lambda c: (c["atMs"], c["index"]))


def claim_onsets(cues: list[dict], onsets: list[dict], window_ms: int) -> dict[int, int]:
    """cue index -> onset position, by an order-preserving best match.

    Cues and onsets are both sorted by time. The match leaves as few cues without an onset as
    possible, then minimises the summed |onset - atMs|; a pair further apart than the window is never
    matched. The result does not depend on the order cues are listed in.
    """
    n, m = len(cues), len(onsets)
    skip = (window_ms + 1) * (m + 1)  # one missed cue costs more than any set of deltas
    cost = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        cost[i][0] = i * skip
        for j in range(1, m + 1):
            best = min(cost[i - 1][j] + skip, cost[i][j - 1])
            d = abs(onsets[j - 1]["ms"] - cues[i - 1]["atMs"])
            if d <= window_ms:
                best = min(best, cost[i - 1][j - 1] + d)
            cost[i][j] = best
    claimed: dict[int, int] = {}
    i, j = n, m
    while i > 0 and j > 0:
        d = abs(onsets[j - 1]["ms"] - cues[i - 1]["atMs"])
        if d <= window_ms and cost[i][j] == cost[i - 1][j - 1] + d:
            claimed[cues[i - 1]["index"]] = j - 1
            i, j = i - 1, j - 1
        elif cost[i][j] == cost[i][j - 1]:
            j -= 1
        else:
            i -= 1
    return claimed


def check_cue_timing(cues, onsets, claimed, fps, limits) -> dict:
    tol_ms = limits["toleranceFrames"] * 1000.0 / fps
    rows, failures = [], []
    for cue in cues:
        j = claimed.get(cue["index"])
        onset_ms = None if j is None else onsets[j]["ms"]
        delta = None if onset_ms is None else onset_ms - cue["atMs"]
        row = {
            "cue": cue["index"],
            "atMs": cue["atMs"],
            "onsetMs": onset_ms,
            "deltaMs": delta,
            "deltaFrames": None if delta is None else _r(delta * fps / 1000.0),
        }
        rows.append(row)
        if delta is None or abs(delta) > tol_ms:
            failures.append(row)
    deltas = [abs(r["deltaMs"]) for r in rows if r["deltaMs"] is not None]
    return {
        "id": "cueTiming",
        "rule": f"each cue has an SFX onset within {limits['toleranceFrames']} frame(s) of atMs",
        "status": "skipped" if not cues else ("fail" if failures else "pass"),
        "limitMs": _r(tol_ms),
        "maxAbsDeltaMs": max(deltas) if deltas else None,
        "cues": rows,
        "failures": failures,
    }


def check_one_event(cues, onsets, claimed) -> dict:
    owned = set(claimed.values())
    failures = []
    cue_times = [c["atMs"] for c in cues]
    for j, o in enumerate(onsets):
        if j in owned:
            continue
        k = bisect.bisect_right(cue_times, o["ms"])
        failures.append({"onsetMs": o["ms"], "afterCue": cues[k - 1]["index"] if k else None})
    return {
        "id": "oneEventPerCue",
        "rule": "every SFX onset belongs to a cue (no second event inside a cue's sample)",
        "status": "fail" if failures else "pass",
        "onsets": len(onsets),
        "extraOnsets": len(failures),
        "failures": failures,
    }


def check_spacing(onsets, limits) -> dict:
    gap_min = limits["minGapMs"]
    pairs = [
        {"aMs": a["ms"], "bMs": b["ms"], "gapMs": b["ms"] - a["ms"]}
        for a, b in itertools.pairwise(onsets)
    ]
    failures = [p for p in pairs if p["gapMs"] < gap_min]
    return {
        "id": "spacing",
        "rule": f"no two SFX onsets closer than {gap_min} ms",
        "status": "fail" if failures else "pass",
        "minGapMs": min((p["gapMs"] for p in pairs), default=None),
        "limitMs": gap_min,
        "failures": failures,
    }


def check_under_speech(onsets, sfx_kw, speech, speech_kw, limits, cfg) -> dict:
    rule = f"while speech is active, SFX is at least {limits['minMarginLu']} LU below speech"
    if speech is None:
        return {"id": "sfxUnderSpeech", "rule": rule, "status": "skipped",
                "reason": "no speech stem", "failures": []}  # fmt: skip
    rows, failures = [], []
    win = cfg["overlapWindowMs"]
    for o in onsets:
        a, b = o["ms"], o["ms"] + win
        active = dsp.speech_active_fraction(speech, a, b, cfg) >= cfg["speechActiveMinFraction"]
        margin = None
        if active:
            margin = dsp.lu_between(
                dsp.window_ms_power(speech_kw, a, b), dsp.window_ms_power(sfx_kw, a, b)
            )
        row = {"onsetMs": o["ms"], "speechActive": active, "marginLu": _r(margin)}
        rows.append(row)
        if active and margin < limits["minMarginLu"]:
            failures.append(row)
    margins = [r["marginLu"] for r in rows if r["marginLu"] is not None]
    return {
        "id": "sfxUnderSpeech",
        "rule": rule,
        "status": "fail" if failures else "pass",
        "limitLu": limits["minMarginLu"],
        "windowMs": win,
        "minMarginLu": min(margins) if margins else None,
        "onsets": rows,
        "failures": failures,
    }


def check_loudness(mix, tp, target, limits) -> dict:
    lufs = dsp.integrated_lufs(mix)
    clipped = dsp.clipped_samples(mix, limits["clipLevel"], limits["clipMinRun"])
    delta = None if lufs is None else lufs - target
    parts = {
        "integrated": "fail" if delta is None or abs(delta) > limits["toleranceLu"] else "pass",
        "truePeak": "fail" if tp > limits["maxTruePeakDbtp"] else "pass",
        "clipping": "fail" if clipped else "pass",
    }
    return {
        "id": "loudness",
        "rule": (
            f"integrated loudness at the target +-{limits['toleranceLu']} LU, true peak <= "
            f"{limits['maxTruePeakDbtp']} dBTP, no clipped samples"
        ),
        "status": "fail" if "fail" in parts.values() else "pass",
        "integratedLufs": _r(lufs),
        "targetLufs": target,
        "deltaLu": _r(delta),
        "toleranceLu": limits["toleranceLu"],
        "truePeakDbtp": _r(tp),
        "maxTruePeakDbtp": limits["maxTruePeakDbtp"],
        "clippedSamples": clipped,
        "parts": parts,
        "failures": [k for k, v in parts.items() if v == "fail"],
    }


def listen_items(cues, onsets, claimed, under: dict) -> list[dict]:
    """Up to five moments: hero cues, then the loudest SFX hits, then the largest speech overlaps."""
    heroes = [
        {"atMs": c["atMs"], "kind": "hero cue",
         "listenFor": f"cue {c['index']} ({c['type']}): one clean hit that lands with the picture"}
        for c in cues if c["hero"]
    ]  # fmt: skip
    loud = [
        {"atMs": o["ms"], "kind": "loud SFX",
         "listenFor": f"peak {o['peakDbfs']:.1f} dBFS: harshness, or a hit that covers the voice"}
        for o in sorted(onsets, key=lambda o: -o["peakDbfs"])
    ]  # fmt: skip
    rows = [r for r in under.get("onsets", []) if r["speechActive"]]
    overlaps = [
        {"atMs": r["onsetMs"], "kind": "speech overlap",
         "listenFor": f"SFX {r['marginLu']:.1f} LU under the voice: can you still follow the words"}
        for r in sorted(rows, key=lambda r: r["marginLu"])
    ]  # fmt: skip
    picked: list[dict] = []

    def take(pool: list[dict], limit: int) -> None:
        n = 0
        for item in pool:
            if len(picked) >= 5 or n >= limit:
                return
            if all(abs(item["atMs"] - p["atMs"]) >= 500 for p in picked):
                picked.append(item)
                n += 1

    take(heroes, 2)
    take(loud, 2)
    take(overlaps, 1)
    take(heroes, 5)
    take(overlaps, 5)
    take(loud, 5)
    order = {"hero cue": 0, "loud SFX": 1, "speech overlap": 2}
    return sorted(picked, key=lambda p: (order[p["kind"]], p["atMs"]))


def run_mix(req: dict, ffmpeg: str, whitelist: str, out_dir: Path) -> dict:
    for name in ("mix", "stems", "cues", "fps", "target"):
        if name not in req:
            raise _tool.ToolError("INVALID_REQUEST", f"missing field: {name}")
    stems = _tool.check_request(req["stems"], {"sfx": (str, True), "speech": (str, False)})
    fps = _tool.number_in(req, "fps", 30, 23, 61)  # the engine's frame rates run from 23.976 to 60
    target = _tool.number_in(req, "target", -14, -71, 1)
    cues = parse_cues(req["cues"])
    paths = {
        "mix": _tool.existing_file(req["mix"]),
        "sfx": _tool.existing_file(stems["sfx"]),
        "speech": _tool.existing_file(stems["speech"]) if "speech" in stems else None,
    }
    th = dsp.load_thresholds()
    lim, cfg = th["checks"], th["analysis"]

    cap = cfg["maxMixSeconds"]

    def decoded(path: Path, channels: int | None) -> np.ndarray:
        x = dsp.decode(path, ffmpeg, whitelist, channels=channels, max_s=cap)
        if len(x) > cap * dsp.RATE:
            raise _tool.ToolError("INPUT_TOO_LONG", f"{path.name} is longer than {cap} s")
        return x

    _tool.progress(0.05, "decoding mix")
    mix = decoded(paths["mix"], None)
    true_peak = dsp.peak_dbtp(
        dsp.sample_peak_stream(paths["mix"], ffmpeg, whitelist, cfg["truePeakRateHz"], cap)
    )
    _tool.progress(0.3, "decoding stems")
    sfx = decoded(paths["sfx"], 1)[:, 0]
    speech = decoded(paths["speech"], 1)[:, 0] if paths["speech"] is not None else None
    duration_ms = mix.shape[0] * 1000.0 / dsp.RATE

    _tool.progress(0.5, "checking")
    onsets = dsp.find_onsets(sfx, cfg)
    claimed = claim_onsets(cues, onsets, cfg["cueMatchWindowMs"])
    sfx_kw = dsp.k_weight(sfx)
    speech_kw = dsp.k_weight(speech) if speech is not None else None
    checks = [
        check_cue_timing(cues, onsets, claimed, fps, lim["cueTiming"]),
        check_one_event(cues, onsets, claimed),
        check_spacing(onsets, lim["spacing"]),
        check_under_speech(onsets, sfx_kw, speech, speech_kw, lim["sfxUnderSpeech"], cfg),
        check_loudness(mix, true_peak, target, lim["loudness"]),
    ]
    under = checks[3]

    owner = {j: c for c, j in claimed.items()}
    _tool.progress(0.8, "writing qa.png and LISTEN.md")
    rows = [("sfx", sfx)]
    if speech is not None:
        rows.append(("speech", speech))
    rows.append(("mix", mix.max(axis=1) if mix.shape[1] > 1 else mix[:, 0]))
    png, layout = render.render_qa_png(rows, duration_ms, cues, onsets)
    listen = listen_items(cues, onsets, claimed, under)
    for item in listen:
        item["timecode"] = render.timecode(item["atMs"])
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "qa.png").write_bytes(png)
    (out_dir / "LISTEN.md").write_text(
        render.listen_markdown(
            listen, f"Mix: `{paths['mix'].name}`, {fps:g} fps, {len(cues)} cues."
        ),
        encoding="utf-8",
    )
    qa = {
        "schemaVersion": 1,
        "mode": "mix",
        "pass": all(c["status"] != "fail" for c in checks),
        "note": NOTE,
        "fps": fps,
        "targetLufs": target,
        "durationMs": round(duration_ms),
        "checks": checks,
        "cues": cues,
        "onsets": [
            {"ms": o["ms"], "peakDbfs": _r(o["peakDbfs"], 1), "cue": owner.get(j)}
            for j, o in enumerate(onsets)
        ],
        "listen": listen,
        "png": {"file": "qa.png", **layout},
        "files": {"qaJson": "qa.json", "png": "qa.png", "listen": "LISTEN.md"},
        "thresholds": th,
    }
    (out_dir / "qa.json").write_text(json.dumps(qa, indent=2, allow_nan=False) + "\n")
    qa["outDir"] = str(out_dir)
    return qa


# ---- kit mode ----


def check_kit_file(x: np.ndarray, ty: str, lim: dict, cfg: dict) -> list[dict]:
    """The styles spec "SFX rules" checks for one SFX file (mono 48 kHz)."""
    rate = dsp.RATE
    share = dsp.peak_energy_share(x, cfg["peakHalfWidthHz"])
    onsets = dsp.find_onsets(x, cfg)
    flat = dsp.flatness_frames(
        x, cfg["flatnessFrame"], cfg["flatnessHop"], cfg["flatnessActiveFloorDbfs"]
    )
    flat_fraction = float((flat >= lim["noiseFlatness"]).mean()) if len(flat) else 0.0
    edge = max(1, int(rate * lim["edgeMs"] / 1000))
    head = float(dsp.to_db(np.abs(x[:edge]).max())) if len(x) else -120.0
    tail = float(dsp.to_db(np.abs(x[-edge:]).max())) if len(x) else -120.0
    peak = float(dsp.to_db(np.abs(x).max())) if len(x) else -120.0
    length = len(x) * 1000.0 / rate

    def item(cid, ok, rule, **numbers):
        return {"id": cid, "pass": bool(ok), "rule": rule, **numbers}

    return [
        item("notSynthesised", share <= lim["maxPeakEnergyShare"],
             f"no single spectral peak holds more than {lim['maxPeakEnergyShare']:.0%} of the energy",
             peakEnergyShare=_r(share, 3)),
        item("oneEvent", len(onsets) == lim["maxOnsets"],
             f"exactly {lim['maxOnsets']} onset ({ty})", onsets=len(onsets),
             onsetsMs=[o["ms"] for o in onsets]),
        item("notNoiseBed", flat_fraction < lim["noiseFrameFraction"],
             f"spectral flatness below {lim['noiseFlatness']} in some active frames",
             flatFrameFraction=_r(flat_fraction, 3)),
        item("cleanEdges", head <= lim["edgeMaxDbfs"] and tail <= lim["edgeMaxDbfs"],
             f"first and last {lim['edgeMs']} ms at or below {lim['edgeMaxDbfs']} dBFS",
             startDbfs=_r(head, 1), endDbfs=_r(tail, 1)),
        item("peak", peak <= lim["maxPeakDbfs"], f"peak at or below {lim['maxPeakDbfs']} dBFS",
             peakDbfs=_r(peak, 1)),
        item("length", length <= lim["maxLengthMs"], f"length at most {lim['maxLengthMs']} ms",
             lengthMs=round(length)),
    ]  # fmt: skip


def run_kit(req: dict, ffmpeg: str, whitelist: str, out_dir: Path) -> dict:
    style = req.get("styleId")
    if not isinstance(style, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", style):
        raise _tool.ToolError("INVALID_REQUEST", "styleId must match [A-Za-z0-9._-]{1,64}")
    if style.startswith("."):
        raise _tool.ToolError("INVALID_REQUEST", "styleId must not start with a dot")
    files = req.get("files")
    if not isinstance(files, list) or not files or len(files) > 64:
        raise _tool.ToolError("INVALID_REQUEST", "files must be a list of 1 to 64 entries")
    th = dsp.load_thresholds()
    max_len_s = th["checks"]["kit"]["maxLengthMs"] / 1000.0
    results, sheet = [], []
    for i, f in enumerate(files):
        entry = _tool.check_request(f, {"path": (str, True), "type": (str, True)})
        if entry["type"] not in CUE_TYPES:
            raise _tool.ToolError("INVALID_REQUEST", f"files[{i}]: unknown type {entry['type']}")
        path = _tool.existing_file(entry["path"])
        _tool.progress(i / len(files), f"checking {path.name}")
        # Decoding stops one second past the length limit: a longer file fails `length` anyway.
        x = dsp.decode(path, ffmpeg, whitelist, channels=1, max_s=max_len_s)[:, 0]
        checks = check_kit_file(x, entry["type"], th["checks"]["kit"], th["analysis"])
        ok = all(c["pass"] for c in checks)
        results.append({"path": str(path), "type": entry["type"], "pass": ok, "checks": checks})
        sheet.append((x, ok))
    out_dir.mkdir(parents=True, exist_ok=True)
    png_name, json_name = f"kit-{style}.png", f"kit-{style}.json"
    (out_dir / png_name).write_bytes(render.render_kit_png(sheet))
    kit = {
        "schemaVersion": 1,
        "mode": "kit",
        "styleId": style,
        "pass": all(r["pass"] for r in results),
        "note": NOTE,
        "files": results,
        "sheet": {"file": png_name, "entries": len(results)},
        "thresholds": th,
    }
    (out_dir / json_name).write_text(json.dumps(kit, indent=2, allow_nan=False) + "\n")
    kit["outDir"] = str(out_dir)
    return kit


def handle(raw: dict) -> dict:
    req = _tool.check_request(raw, REQUEST)
    mode = req.get("mode", "mix")
    if mode not in ("mix", "kit"):
        raise _tool.ToolError("INVALID_REQUEST", "mode must be mix or kit")
    if not os.path.isabs(req["outDir"]) or "\x00" in req["outDir"]:
        raise _tool.ToolError("INVALID_REQUEST", "outDir must be an absolute path")
    ffmpeg = req.get("ffmpeg", "ffmpeg")
    whitelist = req.get("formatWhitelist", _tool.DEFAULT_FORMAT_WHITELIST)
    out_dir = Path(req["outDir"])
    mix_only = {"mix", "stems", "cues", "fps", "target"}
    kit_only = {"styleId", "files"}
    stray = (kit_only if mode == "mix" else mix_only) & set(req)
    if stray:
        raise _tool.ToolError(
            "INVALID_REQUEST", f"fields not allowed in {mode} mode: {sorted(stray)}"
        )
    result = (
        run_mix(req, ffmpeg, whitelist, out_dir)
        if mode == "mix"
        else run_kit(req, ffmpeg, whitelist, out_dir)
    )
    _tool.progress(1.0, "done")
    return result


if __name__ == "__main__":
    _tool.main(handle)
