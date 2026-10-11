"""Test-only tool for the engine's Python bridge (packages/engine/test/py). Not used by the app.

Reads one JSON request on stdin, writes JSON-lines progress on stderr and one JSON result on stdout.
"""

import json
import sys


def main() -> None:
    request = json.load(sys.stdin)
    steps = min(int(request.get("progressSteps", 0)), 1000)
    for i in range(steps):
        print(json.dumps({"progress": (i + 1) / steps}), file=sys.stderr, flush=True)
    if "fail" in request:
        raise RuntimeError(str(request["fail"]))
    json.dump({"echo": request.get("payload")}, sys.stdout)


if __name__ == "__main__":
    main()
