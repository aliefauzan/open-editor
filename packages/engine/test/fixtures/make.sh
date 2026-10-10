#!/usr/bin/env bash
# Offline fixture generator (plan phase 00, R7, D-15, D-16).
#
#   make.sh               build every generated fixture into out/ (gitignored) and transcripts/spike-90s.json
#   make.sh --seed-media  build ONLY the checked-in seed media (talking-head-20s .mp4/.mov/.webm) into
#                         assets/media/ and write assets/media/SEEDS.json. Run once on the M5 and commit.
#
# Inputs: ffmpeg, ffprobe, macOS `say`, awk, shasum, and the checked-in assets/. No network.
# Deterministic: fixed durations, fixed expressions, fixed voice. `say` output may differ between macOS
# versions, so tests on these files assert tolerances, never exact bytes (D-16).
#
# Frame counter: the Homebrew ffmpeg has no `drawtext` (no libfreetype), so the burnt-in frame counter is
# a 16-bit binary barcode in the top-left corner (cells of 40 px, MSB first, white = 1, black = 0),
# produced with `geq`. Read it by sampling the centre of each cell. See plan DECISIONS.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$DIR/assets"
OUT="$DIR/out"
VOICE="Samantha"
FF=(ffmpeg -nostdin -hide_banner -loglevel error -y)
ENC_V=(-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -g 30 -flags:v +bitexact -fflags +bitexact)
ENC_A=(-c:a aac -b:a 160k -ar 48000 -ac 1 -flags:a +bitexact)
META=(-map_metadata -1 -movflags +faststart)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# barcode FPS DUR -> lavfi source producing the frame-number barcode (16 bits, 40 px cells).
barcode() {
  echo "color=c=black:s=640x40:r=$1:d=$2,format=yuv420p,geq=lum='255*mod(floor(N/pow(2,15-floor(X/40))),2)':cb=128:cr=128"
}

# speech TEXT OUT.wav DUR -> mono 48 kHz wav of `say`, padded or cut to DUR seconds.
speech() {
  local text="$1" out="$2" dur="$3"
  say -v "$VOICE" -r 185 -o "$TMP/say.aiff" "$text"
  local got
  got="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/say.aiff")"
  awk -v g="$got" -v d="$dur" 'BEGIN { if (g > d) { print "make.sh: speech is " g " s, longer than " d " s" > "/dev/stderr"; exit 1 } }'
  "${FF[@]}" -i "$TMP/say.aiff" -af "apad" -t "$dur" -ar 48000 -ac 1 -c:a pcm_s16le "$out"
}

# click_expr PERIOD_S -> aevalsrc expression: a 10 ms 1 kHz burst at t = k * PERIOD.
click_expr() {
  echo "if(lt(mod(t,$1),0.01),0.8*sin(2*PI*1000*t),0)"
}

# flash FPS_NUM FPS_DEN -> drawbox filter: white 160 px box bottom-right on frame n = k * 60 (every 2 s at 30 fps).
flash() {
  echo "drawbox=x=iw-200:y=ih-200:w=160:h=160:color=white:t=fill:enable='eq(mod(n,60),0)'"
}

TALKING_TEXT="Hello, and welcome to the Vox Studio demo. [[slnc 250]] Today we turn a long video into a short clip. [[slnc 250]] First, we find the best moments in the footage. [[slnc 250]] Then we add captions and a few sound effects. [[slnc 250]] Every change can be undone at any time. [[slnc 250]] Finally, we export a vertical video for your phone. [[slnc 250]] That is all for this quick test."

# talking_head OUT.mp4 -> 20 s 1080p: face-a slow pan over testsrc2 + `say` speech (7 sentences).
talking_head() {
  local out="$1"
  speech "$TALKING_TEXT" "$TMP/talk.wav" 20
  "${FF[@]}" \
    -f lavfi -i "testsrc2=s=1920x1080:r=30:d=20" \
    -loop 1 -framerate 30 -t 20 -i "$ASSETS/faces/face-a.jpg" \
    -i "$TMP/talk.wav" \
    -filter_complex "[1:v]scale=-2:900[f];[0:v][f]overlay=x='(W-w)/2+200*sin(2*PI*t/20)':y=90,format=yuv420p[v]" \
    -map "[v]" -map 2:a -t 20 "${ENC_V[@]}" -crf 33 "${ENC_A[@]}" "${META[@]}" "$out"
}

seed_media() {
  local dir="$ASSETS/media"
  mkdir -p "$dir"
  talking_head "$dir/talking-head-20s.mp4"
  "${FF[@]}" -i "$dir/talking-head-20s.mp4" -c copy -map_metadata -1 -f mov "$dir/talking-head-20s.mov"
  "${FF[@]}" -i "$dir/talking-head-20s.mp4" \
    -c:v libvpx-vp9 -b:v 0 -crf 46 -row-mt 1 -cpu-used 4 -pix_fmt yuv420p \
    -c:a libopus -b:a 64k -ar 48000 -ac 1 -map_metadata -1 -fflags +bitexact "$dir/talking-head-20s.webm"
  {
    printf '{\n'
    local first=1 f
    for f in talking-head-20s.mp4 talking-head-20s.mov talking-head-20s.webm; do
      [ "$first" = 1 ] || printf ',\n'
      first=0
      printf '  "%s": { "sha256": "%s", "size": %s }' "$f" \
        "$(shasum -a 256 "$dir/$f" | cut -d' ' -f1)" "$(stat -f %z "$dir/$f")"
    done
    printf '\n}\n'
  } > "$dir/SEEDS.json"
  echo "seed media written to $dir"
}

if [ "${1:-}" = "--seed-media" ]; then
  seed_media
  exit 0
fi

mkdir -p "$OUT" "$DIR/transcripts"

# ---- spike-source-1080p.mp4: 90 s, barcode counter, flash every 2 s, click track every 2 s ----
"${FF[@]}" \
  -f lavfi -i "testsrc2=s=1920x1080:r=30:d=90" \
  -f lavfi -i "$(barcode 30 90)" \
  -f lavfi -i "aevalsrc='$(click_expr 2)':s=48000:d=90:c=mono" \
  -filter_complex "[0:v][1:v]overlay=40:40,$(flash),format=yuv420p[v]" \
  -map "[v]" -map 2:a -t 90 "${ENC_V[@]}" "${ENC_A[@]}" "${META[@]}" "$OUT/spike-source-1080p.mp4"

# ---- face-2people.mp4: face-a large, face-b small, side by side, 5 s, no audio ----
"${FF[@]}" \
  -f lavfi -i "color=c=0x203040:s=1920x1080:r=30:d=5" \
  -loop 1 -framerate 30 -t 5 -i "$ASSETS/faces/face-a.jpg" \
  -loop 1 -framerate 30 -t 5 -i "$ASSETS/faces/face-b.jpg" \
  -filter_complex "[1:v]scale=-2:900[a];[2:v]scale=-2:450[b];[0:v][a]overlay=x=300:y=90[t];[t][b]overlay=x=1250:y=315,format=yuv420p[v]" \
  -map "[v]" -t 5 "${ENC_V[@]}" "${META[@]}" "$OUT/face-2people.mp4"

# ---- phone-vfr-20s.mp4: 1080x1920, own barcode counter, jittered pts (VFR), speech ----
speech "Welcome back to the channel. [[slnc 250]] Today I want to show you something quick. [[slnc 250]] This clip was filmed on a phone. [[slnc 250]] The frame rate is not constant. [[slnc 250]] Some frames arrive a little early. [[slnc 250]] Others show up a little late. [[slnc 250]] That is normal for phone video." "$TMP/vfr.wav" 20
"${FF[@]}" \
  -f lavfi -i "testsrc2=s=1080x1920:r=30:d=20" \
  -f lavfi -i "$(barcode 30 20)" \
  -i "$TMP/vfr.wav" \
  -filter_complex "[0:v][1:v]overlay=40:40,format=yuv420p,settb=1/90000,setpts='(N/30+0.015*sin(N*12.9898))/TB'[v]" \
  -map "[v]" -map 2:a -t 20 -fps_mode vfr -enc_time_base 1/90000 -video_track_timescale 90000 "${ENC_V[@]}" "${ENC_A[@]}" "${META[@]}" "$OUT/phone-vfr-20s.mp4"

# ---- ntsc-2997-20s.mp4: 30000/1001, counter, flash every 60 frames, click every 60 frames, speech ----
speech "This clip runs at twenty nine point nine seven frames per second. [[slnc 250]] Broadcast video uses this rate. [[slnc 250]] The frame counter sits in the corner. [[slnc 250]] A white box flashes every two seconds. [[slnc 250]] A click sounds at the same moment. [[slnc 250]] Editors must keep picture and sound together. [[slnc 250]] That is the whole point of this test." "$TMP/ntsc.wav" 20
NTSC_PERIOD="$(awk 'BEGIN { printf "%.6f", 60 * 1001 / 30000 }')"
"${FF[@]}" \
  -f lavfi -i "testsrc2=s=1920x1080:r=30000/1001:d=20" \
  -f lavfi -i "$(barcode 30000/1001 20)" \
  -f lavfi -i "aevalsrc='$(click_expr "$NTSC_PERIOD")':s=48000:d=20:c=mono" \
  -i "$TMP/ntsc.wav" \
  -filter_complex "[0:v][1:v]overlay=40:40,$(flash),format=yuv420p[v];[2:a][3:a]amix=inputs=2:normalize=0:duration=longest[a]" \
  -map "[v]" -map "[a]" -t 20 "${ENC_V[@]}" "${ENC_A[@]}" "${META[@]}" "$OUT/ntsc-2997-20s.mp4"

# ---- cuts-2shot.mp4 (+ .cuts.json): face-a shot, face-b shot, no-face shot with a bright moving box ----
# 30 fps, 3 s each: hard cuts at frame 90 (3000 ms) and frame 180 (6000 ms).
"${FF[@]}" \
  -f lavfi -i "color=c=0x303030:s=1920x1080:r=30:d=3" \
  -loop 1 -framerate 30 -t 3 -i "$ASSETS/faces/face-a.jpg" \
  -f lavfi -i "color=c=0x303030:s=1920x1080:r=30:d=3" \
  -loop 1 -framerate 30 -t 3 -i "$ASSETS/faces/face-b.jpg" \
  -f lavfi -i "testsrc2=s=1920x1080:r=30:d=3" \
  -filter_complex "[1:v]scale=-2:900[a];[0:v][a]overlay=x=250:y=90[s1];[3:v]scale=-2:900[b];[2:v][b]overlay=x=950:y=90[s2];[4:v]drawbox=x='mod(t*500,1700)':y=450:w=140:h=140:color=yellow:t=fill[s3];[s1][s2][s3]concat=n=3:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -t 9 "${ENC_V[@]}" -g 300 "${META[@]}" "$OUT/cuts-2shot.mp4"
cat > "$OUT/cuts-2shot.cuts.json" <<'EOF'
{ "fps": 30, "durationMs": 9000, "cutFrames": [90, 180], "cutsMs": [3000, 6000] }
EOF

# ---- podcast-2face.mp4: equal faces; face-b grows 1.4x for 0.5 s (3.0 s) and 1.5 s (7.0 s), 12 s ----
"${FF[@]}" \
  -f lavfi -i "color=c=0x203040:s=1920x1080:r=30:d=12" \
  -loop 1 -framerate 30 -t 12 -i "$ASSETS/faces/face-a.jpg" \
  -loop 1 -framerate 30 -t 12 -i "$ASSETS/faces/face-b.jpg" \
  -filter_complex "[1:v]scale=-2:640[a];[2:v]scale=w='512*if(between(t,3,3.5)+between(t,7,8.5),1.4,1)':h=-2:eval=frame[b];[0:v][a]overlay=x=300:y='H/2-h/2'[t];[t][b]overlay=x='1440-w/2':y='H/2-h/2':eval=frame,format=yuv420p[v]" \
  -map "[v]" -t 12 "${ENC_V[@]}" "${META[@]}" "$OUT/podcast-2face.mp4"

# ---- speech-fillers.wav: "um", "uh", a back-to-back repeat, silences of 200 ms and 600 ms ----
FILLERS_TEXT="So, um, I think I think we should, uh, start now. [[slnc 200]] The first point is simple. [[slnc 600]] It just works."
speech "$FILLERS_TEXT" "$OUT/speech-fillers.wav" 12

# ---- music-silence.wav: 8 s synthetic music (chords + beat), 4 s silence, one sentence ----
say -v "$VOICE" -r 185 -o "$TMP/ms.aiff" "This sentence follows the silence."
"${FF[@]}" \
  -f lavfi -i "aevalsrc='0.15*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t))*if(lt(mod(t,4),2),1,0.7)+0.5*sin(2*PI*60*t)*exp(-12*mod(t,0.5))':s=48000:d=8:c=mono" \
  -f lavfi -i "anullsrc=r=48000:cl=mono:d=4" \
  -i "$TMP/ms.aiff" \
  -filter_complex "[2:a]aresample=48000,aformat=channel_layouts=mono[s];[0:a][1:a][s]concat=n=3:v=0:a=1[a]" \
  -map "[a]" -c:a pcm_s16le "$OUT/music-silence.wav"

# ---- transcripts/spike-90s.json: fixed word list with timings across 90 s (the spike source has no speech) ----
awk 'BEGIN {
  n = split("the quick brown fox jumps over a lazy dog while editing clips on the timeline with sound and captions", W, " ")
  t = 500; i = 0; printf "{\n  \"language\": \"en\",\n  \"words\": [\n"
  regStart = t; first = 1; regions = ""
  while (t < 89000) {
    w = W[(i % n) + 1]; d = 120 + 40 * length(w) / 2 + 0; d = int(d)
    if (!first) printf ",\n"; first = 0
    printf "    { \"text\": \"%s\", \"startMs\": %d, \"endMs\": %d, \"kind\": \"word\" }", w, t, t + d
    t += d; i++
    if (i % 10 == 0) {
      if (t + 600 < 89000) {
        printf ",\n    { \"text\": \"\", \"startMs\": %d, \"endMs\": %d, \"kind\": \"pause\" }", t, t + 600
        regions = regions (regions == "" ? "" : ", ") sprintf("{ \"startMs\": %d, \"endMs\": %d }", regStart, t)
        t += 600; regStart = t
      }
    } else { t += 90 }
  }
  regions = regions (regions == "" ? "" : ", ") sprintf("{ \"startMs\": %d, \"endMs\": %d }", regStart, t)
  printf "\n  ],\n  \"speechRegions\": [ %s ]\n}\n", regions
}' > "$DIR/transcripts/spike-90s.json"

echo "fixtures written to $OUT"
