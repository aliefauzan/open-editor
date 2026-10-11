#!/usr/bin/env bash
# Fresh-clone check (plan phase 13 step 8b, D-16): what a builder who clones the repo gets.
#   git clone → pnpm install --frozen-lockfile → pnpm dist (or dist:no-apple) → `vox self-test --json`
#   from the built app's CLI, with a temp HOME and a PATH without Homebrew.
# Only committed files count: the clone checks out a commit, so local edits are not part of it.
#
# Usage: bash scripts/fresh-clone-check.sh [--no-apple] [--repo <path-or-url>] [--ref <commit-or-branch>]
#   default repo: this checkout's repository; default ref: its HEAD commit.
# The clone stays in a temp folder (its path is printed) so a failure can be looked at; delete it
# when done.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
ref="$(git -C "$here" rev-parse HEAD)"
dist="dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-apple) dist="dist:no-apple" ;;
    --repo) repo="$2"; shift ;;
    --ref) ref="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

work="$(mktemp -d "${TMPDIR:-/tmp}/vox-fresh-clone-XXXXXX")"
log="$work/fresh-clone.log"
clone="$work/open-editor"
echo "fresh-clone check: $repo @ $ref → $clone (log: $log)"

stage() {
  local name="$1"; shift
  local t0=$SECONDS
  echo "== $name" | tee -a "$log"
  if ! "$@" >>"$log" 2>&1; then
    echo "FAIL: $name (see $log)" >&2
    tail -30 "$log" >&2
    exit 1
  fi
  echo "   $name: $((SECONDS - t0)) s" | tee -a "$log"
}

stage "git clone" git clone --quiet "$repo" "$clone"
stage "checkout $ref" git -C "$clone" checkout --quiet --detach "$ref"
stage "pnpm install --frozen-lockfile" pnpm -C "$clone" install --frozen-lockfile
stage "pnpm $dist" pnpm -C "$clone" "$dist"

app="$clone/apps/desktop/dist/mac-arm64/Vox Studio.app"
dmg="$(ls "$clone"/apps/desktop/dist/*.dmg 2>/dev/null | head -1 || true)"
[ -d "$app" ] || { echo "FAIL: no app at $app" >&2; exit 1; }
[ -n "$dmg" ] || { echo "FAIL: no .dmg in $clone/apps/desktop/dist" >&2; exit 1; }

home="$(mktemp -d "$work/home-XXXXXX")"
out="$work/self-test.json"
echo "== vox self-test --json (temp HOME, PATH=/usr/bin:/bin)" | tee -a "$log"
if ! HOME="$home" PATH=/usr/bin:/bin "$app/Contents/Resources/cli/vox" self-test --json >"$out" 2>>"$log"; then
  echo "FAIL: vox self-test exited non-zero" >&2
  cat "$out" >&2
  exit 1
fi

# every check passed, or notBuilt for the Apple helper of a no-apple build; never skipped (D-12)
summary="$(uv run --no-project python - "$out" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
bad = [c for c in r["checks"] if c["status"] not in ("passed", "notBuilt")]
print(json.dumps({
    "ok": r["ok"] and not bad,
    "packaged": r.get("packaged"),
    "checks": {c["name"]: c["status"] for c in r["checks"]},
    "bad": [c["name"] for c in bad],
}))
PY
)"
echo "$summary" | tee -a "$log"
case "$summary" in
  *'"ok": true'*) ;;
  *) echo "FAIL: self-test has a check that did not pass" >&2; exit 1 ;;
esac

info="$(cat "$app/Contents/Resources/build-info.json")"
size="$(du -h "$dmg" | cut -f1)"
echo "PASS: fresh clone of $ref builds with pnpm $dist; $(basename "$dmg") $size; build-info $info"
echo "clone kept at $work (delete it when done)"
