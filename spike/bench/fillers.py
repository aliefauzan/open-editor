"""Item 8 (recorded only): mlx-whisper on speech-fillers.wav with and without a filler prompt.

Run through `uv run --with mlx-whisper==<pin>` by bench/fillers.ts; prints one JSON object.
"""

import json
import re
import sys
import time
from importlib.metadata import version

import mlx_whisper
from huggingface_hub import snapshot_download

REPO = "mlx-community/whisper-large-v3-turbo"
REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"
FILLER_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. Uh, um, so, you know, I mean."
FILLERS = re.compile(r"^(um+|uh+|umm+|uhm+|hmm+|erm?|ah+)$")


def words(result):
    out = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            out.append({"w": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3)})
    return out


def run(path, prompt, model):
    t0 = time.time()
    r = mlx_whisper.transcribe(
        path,
        path_or_hf_repo=model,
        word_timestamps=True,
        initial_prompt=prompt,
        condition_on_previous_text=False,
        temperature=0.0,
    )
    ws = words(r)
    norm = [re.sub(r"[^a-z]", "", w["w"].lower()) for w in ws]
    fillers = [ws[i]["w"] for i, n in enumerate(norm) if FILLERS.match(n)]
    # back-to-back repeats of 1-3 words ("I think I think")
    repeats = sum(
        1
        for n in (1, 2, 3)
        for i in range(len(norm) - 2 * n + 1)
        if all(norm[i : i + n]) and norm[i : i + n] == norm[i + n : i + 2 * n]
    )
    return {
        "text": r.get("text", "").strip(),
        "language": r.get("language"),
        "words": len(ws),
        "fillers": len(fillers),
        "um": sum(1 for f in fillers if re.sub(r"[^a-z]", "", f.lower()).startswith("um")),
        "uh": sum(1 for f in fillers if re.sub(r"[^a-z]", "", f.lower()).startswith("uh")),
        "backToBackRepeats": repeats,
        "seconds": round(time.time() - t0, 2),
        "wordList": ws,
    }


def main():
    path = sys.argv[1]
    model = snapshot_download(REPO, revision=REVISION)
    run(path, None, model)  # warm-up (model load), not recorded
    plain = run(path, None, model)
    prompted = run(path, FILLER_PROMPT, model)
    print(
        json.dumps(
            {
                "repo": REPO,
                "revision": REVISION,
                "mlxWhisper": version("mlx-whisper"),
                "mlx": version("mlx"),
                "spoken": {"um": 1, "uh": 1, "backToBackRepeats": 1},
                "fillerPrompt": FILLER_PROMPT,
                "withoutPrompt": plain,
                "withPrompt": prompted,
            }
        )
    )


if __name__ == "__main__":
    main()
