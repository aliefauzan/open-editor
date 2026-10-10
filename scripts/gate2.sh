#!/usr/bin/env bash
# GATE 2 run (phase 05 step 14; engine spec "Done when" 4, 7, 8, 9, 10; plan D-11, D-13 to D-16).
#
#   bash scripts/gate2.sh [--youtube <url>] [--instagram <url>] [--tiktok <url>] [--walled <url>]
#                         [--projects-dir <dir>] [--evidence <dir>] [--no-local]
#
# Every section with a URL runs only when its URL is given; the local sections (done-when 9 and 10)
# always run unless --no-local. Projects go to a new temp folder unless --projects-dir is given; it is
# kept and printed at the end (the .otio files point into it, for the Resolve check of step 15).
# Evidence goes to docs/evidence/phase-05/ (JSON, SRT heads, JPEG frames); MP4 and OTIO files go to its
# reference/ folder, which git ignores. Paths under $HOME are written as "~" in the evidence.
# Exit code 0 when every section that ran passed; 14-gate2-summary.json lists them.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$REPO/packages/engine/test/fixtures"
YOUTUBE='' INSTAGRAM='' TIKTOK='' WALLED='' PROJECTS='' EVIDENCE="$REPO/docs/evidence/phase-05" LOCAL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --youtube) YOUTUBE="$2"; shift 2 ;;
    --instagram) INSTAGRAM="$2"; shift 2 ;;
    --tiktok) TIKTOK="$2"; shift 2 ;;
    --walled) WALLED="$2"; shift 2 ;;
    --projects-dir) PROJECTS="$2"; shift 2 ;;
    --evidence) EVIDENCE="$2"; shift 2 ;;
    --no-local) LOCAL=0; shift ;;
    -h|--help) sed -n 2,12p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
for tool in node jq ffmpeg ffprobe shasum; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done
[ -n "$PROJECTS" ] || PROJECTS="$(mktemp -d "${TMPDIR:-/tmp}/vox-gate2-XXXXXX")/Projects"
mkdir -p "$PROJECTS" "$EVIDENCE/reference"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/vox-gate2-work-XXXXXX")"
SUMMARY="$WORK/summary.jsonl"
: >"$SUMMARY"

vox() { node "$REPO/packages/cli/bin/vox.js" "$@" --projects-dir "$PROJECTS"; }
# vox with --json; stdout is the JSON result (or the JSON error), stderr goes to the terminal
voxj() { node "$REPO/packages/cli/bin/vox.js" "$@" --json --projects-dir "$PROJECTS"; }
redact() { sed -e "s#$HOME#~#g" -e "s#$PROJECTS#<projects>#g" -e "s#$WORK#<work>#g"; }
log() { printf '\n== %s\n' "$*" >&2; }
record() { # record <section> <pass true|false> <detail-json>
  jq -cn --arg s "$1" --argjson p "$2" --argjson d "$3" '{section: $s, pass: $p, detail: $d}' >>"$SUMMARY"
  [ "$2" = true ] && echo "PASS $1" >&2 || echo "FAIL $1" >&2
}
probe() { # one JSON line: width, height, codec, fps, audio codec, duration
  ffprobe -v error -show_streams -show_format -of json "$1" | jq -c '{
    video: ([.streams[] | select(.codec_type == "video")][0] | {codec_name, width, height, r_frame_rate, avg_frame_rate}),
    audio: ([.streams[] | select(.codec_type == "audio")][0] | {codec_name, sample_rate, channels}),
    duration: (.format.duration | tonumber)}'
}
jpeg() { # jpeg <mp4> <seconds> <out.jpg>: 540×960 still, well under the 500 kB evidence limit
  ffmpeg -v error -y -ss "$2" -i "$1" -frames:v 1 -vf scale=540:-2 -q:v 5 "$3"
}
srt_head() { head -n 16 "$1"; }
project_json() { cat "$PROJECTS/$1/project.json"; }

# --- caption edit: override one word of a sequence's captions, re-render, check SRT + frame (done-when 7)
caption_edit() { # caption_edit <project> <sequence> <prefix>
  local p="$1" s="$2" pre="$3" word="GATETWO"
  local pj item media rev tpath in_ms idx start
  pj="$(project_json "$p")"
  item="$(jq -c --arg s "$s" '.sequences[] | select(.id == $s) | .videoTracks[0].items[0]' <<<"$pj")"
  media="$(jq -r .mediaId <<<"$item")"
  in_ms="$(jq -r .inMs <<<"$item")"
  rev="$(jq -r --arg m "$media" '.media[] | select(.id == $m) | .transcriptRev' <<<"$pj")"
  tpath="$(jq -r --arg m "$media" '.media[] | select(.id == $m) | .transcriptPath' <<<"$pj")"
  # the first spoken word at least 2 s into the clip
  read -r idx start < <(jq -r --argjson t "$((in_ms + 2000))" \
    '[.words | to_entries[] | select(.value.kind == "word" and .value.startMs >= $t)][0] | "\(.key) \(.value.startMs)"' \
    "$PROJECTS/$p/$tpath")
  vox op "$p" setCaptions "$(jq -cn --arg s "$s" --arg k "$media:$rev:$idx" --arg w "$word" --argjson st "$start" \
    '{sequenceId: $s, overrides: [{wordKey: $k, text: $w, startMs: $st}]}')" >&2
  local out="$WORK/$pre-edit"
  mkdir -p "$out"
  voxj render "$p" --seq "$s" --quality draft --out-dir "$out" >"$WORK/$pre-edit-render.json"
  voxj export-captions "$p" --seq "$s" --format srt --out-dir "$out" >"$WORK/$pre-edit-srt.json"
  local mp4 srt at
  mp4="$(jq -r '.files[0].path' "$WORK/$pre-edit-render.json")"
  srt="$(jq -r .path "$WORK/$pre-edit-srt.json")"
  cp "$mp4" "$EVIDENCE/reference/$pre-edit.mp4"
  grep -n -B2 -A1 "$word" "$srt" >"$EVIDENCE/$pre-edit-srt.txt" || true
  at="$(jq -n --argjson a "$start" --argjson b "$in_ms" '(($a - $b + 150) / 1000)')"
  jpeg "$mp4" "$at" "$EVIDENCE/$pre-edit-frame.jpg"
  local in_srt=false
  grep -q "$word" "$srt" && in_srt=true
  record "$pre caption edit" "$in_srt" "$(jq -cn --arg k "$media:$rev:$idx" --arg w "$word" --argjson at "$at" \
    '{wordKey: $k, text: $w, frameAtSec: $at, frame: "'"$pre"'-edit-frame.jpg (check the word on screen)"}')"
}

# --- done-when 4: real YouTube URL → face-tracked speaker clip, base/title, transition, captions + SRT
youtube_edit() {
  log "YouTube edit: $YOUTUBE"
  local p seq m dur a b
  p="$(voxj new "GATE2 YouTube" | jq -r .id)"
  seq="$(jq -r '.sequences[0].id' <(project_json "$p"))"
  m="$(voxj ingest "$p" "$YOUTUBE" | jq -r '[.media[] | select(.kind == "video")][0].mediaId')"
  for job in shots transcribe facetrack; do vox "$job" "$p" "$m" >&2; done
  dur="$(jq -r --arg m "$m" '.media[] | select(.id == $m) | .durationMs' <(project_json "$p"))"
  # two 6 s face-tracked clips from inside the video (handles for the crossfade), a title, captions
  a=$((dur / 4)); b=$((dur / 2))
  local place='{sequenceId: $s, trackId: "V1", mediaId: $m, durationMs: 6000, withAudio: true, frame: {mode: "auto"}}'
  vox op "$p" placeClip "$(jq -cn --arg s "$seq" --arg m "$m" --argjson i0 "$a" "$place + {startMs: 0, inMs: \$i0}")" >&2
  local second
  second="$(voxj op "$p" placeClip "$(jq -cn --arg s "$seq" --arg m "$m" --argjson i0 "$b" "$place + {startMs: 6000, inMs: \$i0}")" \
    | jq -r '.results[0].report.itemIds[0]')"
  vox op "$p" setTransition "$(jq -cn --arg s "$seq" --arg i "$second" \
    '{sequenceId: $s, itemId: $i, transition: {template: "base/crossfade", durationMs: 500}}')" >&2
  vox op "$p" addScene "$(jq -cn --arg s "$seq" \
    '{sequenceId: $s, trackId: "V2", startMs: 500, durationMs: 2500, template: "base/title", variables: {title: "Vox Studio"}}')" >&2
  vox op "$p" setCaptions "$(jq -cn --arg s "$seq" '{sequenceId: $s, enabled: true}')" >&2
  local out="$WORK/yt"
  mkdir -p "$out"
  voxj render "$p" --seq "$seq" --out-dir "$out" >"$WORK/yt-render.json"
  voxj export-captions "$p" --seq "$seq" --format srt --out-dir "$out" >"$WORK/yt-srt.json"
  voxj export-timeline "$p" --seq "$seq" --out-dir "$EVIDENCE/reference" --overwrite >"$WORK/yt-otio.json"
  local mp4 pr
  mp4="$(jq -r '.files[0].path' "$WORK/yt-render.json")"
  cp "$mp4" "$EVIDENCE/reference/14-youtube.mp4"
  srt_head "$(jq -r .path "$WORK/yt-srt.json")" >"$EVIDENCE/14-youtube-srt-head.txt"
  for t in 1 4 9; do jpeg "$mp4" "$t" "$EVIDENCE/14-youtube-frame-${t}s.jpg"; done
  pr="$(probe "$mp4")"
  echo "$pr" | jq . >"$EVIDENCE/14-youtube-probe.json"
  record "youtube edit (done-when 4)" "$(jq '.video.width == 1080 and .video.height == 1920 and .audio.codec_name == "aac"' <<<"$pr")" \
    "$(jq -cn --argjson pr "$pr" --arg otio "$(jq -r '.path // .files[0].path // empty' "$WORK/yt-otio.json" | redact)" '{probe: $pr, otio: $otio}')"
}

# --- done-when 7: vox quick <url> --render → 3 captioned clips (MP4 + SRT), then one caption edit
quick_url() {
  log "quick on the YouTube URL"
  local out="$WORK/yt-quick"
  mkdir -p "$out"
  voxj quick "$YOUTUBE" --name "GATE2 quick" --render --out-dir "$out" >"$WORK/yt-quick.json"
  local p n
  p="$(jq -r .projectId "$WORK/yt-quick.json")"
  n="$(jq '[.files[] | select(.mp4 != null and .srt != null)] | length' "$WORK/yt-quick.json")"
  jq '{scorer, note, clips: [.clips[] | {name, startMs, endMs, text}]}' "$WORK/yt-quick.json" >"$EVIDENCE/14-quick-url.json"
  srt_head "$(jq -r '.files[0].srt' "$WORK/yt-quick.json")" >"$EVIDENCE/14-quick-url-srt-head.txt"
  record "quick url: 3 clips with MP4 + SRT (done-when 7)" "$([ "$n" -eq 3 ] && echo true || echo false)" "{\"clips\": $n}"
  caption_edit "$p" "$(jq -r '.clips[0].sequenceId' "$WORK/yt-quick.json")" 14-quick-url
}

# --- done-when 8: Instagram reel and TikTok ingest keep 1080×1920; a login-walled post → LOGIN_REQUIRED
ingest_url() { # ingest_url <label> <url>
  log "ingest $1: $2"
  local p r m file pr
  p="$(voxj new "GATE2 $1" | jq -r .id)"
  if ! r="$(voxj ingest "$p" "$2")"; then
    echo "$r" | jq '{error: .error | {code, message, hint}}' | redact >"$EVIDENCE/14-ingest-$1.json"
    record "ingest $1 (done-when 8)" false "$(jq -c '.error | {code, hint}' <<<"$r")"
    return 0
  fi
  m="$(jq -r '[.media[] | select(.kind == "video")][0].mediaId' <<<"$r")"
  file="$(jq -r --arg m "$m" '.media[] | select(.id == $m) | .path' <(project_json "$p"))"
  pr="$(probe "$PROJECTS/$p/$file")"
  echo "$pr" | jq . >"$EVIDENCE/14-ingest-$1-probe.json"
  record "ingest $1 (done-when 8)" true "$pr"
}
walled() {
  log "login-walled: $WALLED"
  local p r
  p="$(voxj new "GATE2 walled" | jq -r .id)"
  r="$(voxj ingest "$p" "$WALLED" || true)"
  echo "$r" | jq '{error: (.error // null | if . then {code, message, hint} else null end), media: (.media // null | if . then length else null end)}' \
    | redact >"$EVIDENCE/14-ingest-walled.json"
  # without the cookies opt-in: LOGIN_REQUIRED with a hint; with it (owner's browser login): ingested
  record "login-walled post (done-when 8)" "$(jq '(.error.code == "LOGIN_REQUIRED" and (.error.hint | length > 0)) or ((.media // []) | length > 0)' <<<"$r")" \
    "$(jq -c '{code: .error.code, ingested: ((.media // []) | length)}' <<<"$r")"
}

# --- done-when 8 + 9: quick on a local file with --render --out-dir outside the project, then audio QA
local_quick_qa() {
  log "quick on the local talking-head fixture + audio-qa"
  local out="$EVIDENCE/reference/out"
  mkdir -p "$out"
  voxj quick "$FIXTURES/assets/media/talking-head-20s.mp4" --name "GATE2 local" --length 4-8 --render --out-dir "$out" \
    >"$WORK/local-quick.json"
  local p s n outside qa
  p="$(jq -r .projectId "$WORK/local-quick.json")"
  s="$(jq -r '.clips[0].sequenceId' "$WORK/local-quick.json")"
  n="$(jq '.files | length' "$WORK/local-quick.json")"
  outside="$(jq --arg d "$out/" '[.files[] | (.mp4 | startswith($d)) and (.srt | startswith($d))] | all' "$WORK/local-quick.json")"
  jq '{scorer, note, clips: [.clips[] | {name, startMs, endMs, text}], files: [.files[] | {mp4: (.mp4 | split("/") | last), srt: (.srt | split("/") | last)}]}' \
    "$WORK/local-quick.json" >"$EVIDENCE/14-quick-local.json"
  record "quick local file --render --out-dir (done-when 8)" "$([ "$n" -ge 1 ] && echo "$outside" || echo false)" "{\"files\": $n}"
  voxj audio-qa "$p" --seq "$s" >"$WORK/qa.json" || true
  qa="$(jq -r .outDir "$WORK/qa.json")"
  local have=true
  for f in qa.json qa.png LISTEN.md; do
    if [ -f "$qa/$f" ]; then cp "$qa/$f" "$EVIDENCE/14-audio-qa-$f"; else have=false; fi
  done
  [ ! -f "$EVIDENCE/14-audio-qa-qa.json" ] || { redact <"$EVIDENCE/14-audio-qa-qa.json" >"$WORK/qa-redacted.json" && mv "$WORK/qa-redacted.json" "$EVIDENCE/14-audio-qa-qa.json"; }
  record "audio-qa writes qa.json, qa.png, LISTEN.md (done-when 9)" "$have" "$(jq -c '{pass, checks: [.checks[]? | {id, status}]}' "$WORK/qa.json")"
}

# --- done-when 10: 29.97 fps and VFR fixtures → frames match the reference frames by their counters
frames_check() { # frames_check <fixture> <label>
  log "quick + frame check: $1"
  local out="$WORK/$2"
  mkdir -p "$out"
  voxj quick "$FIXTURES/out/$1" --name "GATE2 $2" --length 4-8 --render --out-dir "$out" >"$WORK/$2-quick.json"
  local p ok=true
  p="$(jq -r .projectId "$WORK/$2-quick.json")"
  node "$REPO/scripts/gate2-frames.ts" --projects-dir "$PROJECTS" --project "$p" --out "$EVIDENCE/14-frames-$2.json" \
    --work "$WORK/$2-frames" || ok=false
  local detail='{}'
  [ ! -f "$EVIDENCE/14-frames-$2.json" ] || detail="$(jq -c \
    '{clips: [.clips[] | {fps, reference: (.reference | split("/") | last), frames, mismatches: (.mismatches | length)}]}' \
    "$EVIDENCE/14-frames-$2.json")"
  record "frames match the reference on $1 (done-when 10)" "$ok" "$detail"
  echo "$p"
}

# --- done-when 10: removePauses on a quick clip is one history entry; one undo restores the sequence
undo_check() { # undo_check <project>
  log "removePauses + undo"
  local p="$1" s before after_rm after_undo h0 h1
  s="$(jq -r '.sequences[0].id' <(project_json "$p"))"
  before="$(jq -cS --arg s "$s" '.sequences[] | select(.id == $s)' <(project_json "$p"))"
  h0="$(voxj history "$p" | jq length)"
  vox op "$p" removePauses "$(jq -cn --arg s "$s" '{sequenceId: $s, minPauseMs: 200}')" >&2
  h1="$(voxj history "$p" | jq length)"
  after_rm="$(jq -cS --arg s "$s" '.sequences[] | select(.id == $s)' <(project_json "$p"))"
  vox undo "$p" >&2
  after_undo="$(jq -cS --arg s "$s" '.sequences[] | select(.id == $s)' <(project_json "$p"))"
  local changed restored entries
  changed="$([ "$before" != "$after_rm" ] && echo true || echo false)"
  restored="$([ "$before" = "$after_undo" ] && echo true || echo false)"
  entries=$((h1 - h0))
  jq -n --arg s "$s" --argjson e "$entries" --argjson c "$changed" --argjson r "$restored" \
    --argjson n0 "$(jq '[.videoTracks[].items[]] | length' <<<"$before")" \
    --argjson n1 "$(jq '[.videoTracks[].items[]] | length' <<<"$after_rm")" \
    '{sequenceId: $s, historyEntriesAdded: $e, removePausesChangedSequence: $c, v1ItemsBefore: $n0, v1ItemsAfterRemove: $n1, undoRestoredSequence: $r}' \
    >"$EVIDENCE/14-undo-check.json"
  record "removePauses = one undo entry (done-when 10)" "$([ "$entries" -eq 1 ] && [ "$changed" = true ] && [ "$restored" = true ] && echo true || echo false)" \
    "$(jq -c . "$EVIDENCE/14-undo-check.json")"
}

# --- done-when 10: a copy with a newer schemaVersion → SCHEMA_TOO_NEW, files byte-identical
schema_check() { # schema_check <project>
  log "SCHEMA_TOO_NEW on a copy"
  local p="$1" other="$WORK/newer/Projects" r sum0 sum1
  mkdir -p "$other"
  cp -R "$PROJECTS/$p" "$other/$p"
  jq '.schemaVersion += 1' "$other/$p/project.json" >"$WORK/newer.json" && cp "$WORK/newer.json" "$other/$p/project.json"
  sums() { (cd "$other/$p" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-16); }
  sum0="$(sums)"
  r="$(node "$REPO/packages/cli/bin/vox.js" history "$p" --json --projects-dir "$other" || true)"
  node "$REPO/packages/cli/bin/vox.js" op "$p" removePauses "{\"sequenceId\":\"x\"}" --json --projects-dir "$other" >/dev/null 2>&1 || true
  sum1="$(sums)"
  jq -n --argjson r "$r" --arg a "$sum0" --arg b "$sum1" \
    '{code: $r.error.code, hint: $r.error.hint, treeSha256Before: $a, treeSha256After: $b, unchanged: ($a == $b)}' \
    >"$EVIDENCE/14-schema-too-new.json"
  record "newer schemaVersion refused, files unchanged (done-when 10)" \
    "$(jq '.code == "SCHEMA_TOO_NEW" and .unchanged' "$EVIDENCE/14-schema-too-new.json")" "$(jq -c . "$EVIDENCE/14-schema-too-new.json")"
}

if [ -n "$YOUTUBE" ]; then youtube_edit; quick_url; fi
[ -z "$INSTAGRAM" ] || ingest_url instagram "$INSTAGRAM"
[ -z "$TIKTOK" ] || ingest_url tiktok "$TIKTOK"
[ -z "$WALLED" ] || walled
if [ "$LOCAL" = 1 ]; then
  local_quick_qa
  frames_check ntsc-2997-20s.mp4 ntsc >/dev/null
  vfr="$(frames_check phone-vfr-20s.mp4 vfr)"
  undo_check "$vfr"
  schema_check "$vfr"
fi

jq -s '{yt_dlp: $v, sections: ., pass: (map(.pass) | all)}' --arg v "$(yt-dlp --version 2>/dev/null || echo none)" "$SUMMARY" \
  | redact >"$EVIDENCE/14-gate2-summary.json"
echo "projects: $PROJECTS" >&2
echo "evidence: $EVIDENCE" >&2
jq -e .pass "$EVIDENCE/14-gate2-summary.json" >/dev/null
