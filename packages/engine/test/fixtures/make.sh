#!/usr/bin/env bash
# Offline fixture generator (plan phase 00, R7, D-15, D-16).
#
#   make.sh               build every generated fixture into out/ (gitignored) and transcripts/spike-90s.json
#   make.sh --audio-qa    build ONLY the audio QA set (out/audio/, about 7 s)
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
CRF=20
ENC_V=(-c:v libx264 -preset veryfast -crf "$CRF" -pix_fmt yuv420p -g 30 -flags:v +bitexact -fflags +bitexact)
ENC_A=(-c:a aac -b:a 160k -ar 48000 -ac 1 -flags:a +bitexact)
META=(-map_metadata -1 -movflags +faststart)

say -v '?' | grep -q "^$VOICE " || { echo "make.sh: macOS voice $VOICE is missing (say -v '?')" >&2; exit 1; }

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

# flash -> drawbox filter: white 160 px box bottom-right on frame n = k * 60 (every 2 s at 30 and 30000/1001 fps).
flash() {
  echo "drawbox=x=iw-200:y=ih-200:w=160:h=160:color=white:t=fill:enable='eq(mod(n,60),0)'"
}

TALKING_TEXT="Hello, and welcome to the Vox Studio demo. [[slnc 250]] Today we turn a long video into a short clip. [[slnc 250]] First, we find the best moments in the footage. [[slnc 250]] Then we add captions and a few sound effects. [[slnc 250]] Every change can be undone at any time. [[slnc 250]] Finally, we export a vertical video for your phone. [[slnc 250]] That is all for this quick test."

# talking_head OUT.mp4 -> 20 s 1080p: face-a slow pan over testsrc2 + `say` speech (7 sentences).
talking_head() {
  local out="$1"
  CRF=33 # seeds must stay under 5 MB (D-16)
  ENC_V=(-c:v libx264 -preset veryfast -crf "$CRF" -pix_fmt yuv420p -g 30 -flags:v +bitexact -fflags +bitexact)
  speech "$TALKING_TEXT" "$TMP/talk.wav" 20
  "${FF[@]}" \
    -f lavfi -i "testsrc2=s=1920x1080:r=30:d=20" \
    -loop 1 -framerate 30 -t 20 -i "$ASSETS/faces/face-a.jpg" \
    -i "$TMP/talk.wav" \
    -filter_complex "[1:v]scale=-2:900[f];[0:v][f]overlay=x='(W-w)/2+200*sin(2*PI*t/20)':y=90,format=yuv420p[v]" \
    -map "[v]" -map 2:a -t 20 "${ENC_V[@]}" "${ENC_A[@]}" "${META[@]}" "$out"
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

# ---- audio QA set (plan 05 step 8d0, R7, D-14, D-16): out/audio/ ----
# Cases (mono 48 kHz stems `<case>.sfx.wav` and `<case>.speech.wav`, stereo mix `<case>.wav`, and
# `<case>.cues.json` with the cue list, fps and loudness target):
#   good, bad-late (cue 3 three frames late), bad-double-hit (two hits in one sample),
#   bad-close-cues (two cues 50 ms apart), bad-sfx-over-speech (SFX as loud as speech), bad-clipped.
# Kit set: kit-beep, kit-noise-bed, kit-click-start, kit-double-hit (all mono 48 kHz).
# Gains are fixed numbers chosen with wide margins: `say` timing and level may move between macOS versions.
AUDIO_FPS=30
AUDIO_TARGET=-14
AUDIO_LEN=13
AUDIO_CUES_MS=(500 2900 5800 8300 9600 11500) # hero, in speech, silence, speech, speech, hero
AUDIO_SFX_GAIN=-6        # dB on tap.wav in the good mix (well under the speech it overlaps)
AUDIO_SFX_GAIN_LOUD=8    # dB: SFX about as loud as the speech it overlaps

# lufs FILE -> integrated loudness (ebur128), one number.
lufs() {
  ffmpeg -nostdin -hide_banner -nostats -i "$1" -af ebur128 -f null - 2>&1 |
    awk '/Integrated loudness:/ { s = 1 } s && /I:/ { print $2; exit }'
}

# sfx_stem OUT GAIN_DB T1_MS T2_MS ... -> mono 48 kHz stem: tap.wav at each time, AUDIO_LEN seconds.
sfx_stem() {
  local out="$1" gain="$2"; shift 2
  local n=$# i=0 labels="" mix="" joined="" t
  for t in "$@"; do
    labels+="[s$i]"
    mix+="[s$i]adelay=${t}[d$i];"
    joined+="[d$i]"
    i=$((i + 1))
  done
  "${FF[@]}" -i "$ASSETS/sfx/tap.wav" \
    -filter_complex "[0]asplit=$n$labels;${mix}${joined}amix=inputs=$n:normalize=0:duration=longest,volume=${gain}dB,apad,atrim=0:$AUDIO_LEN,aformat=sample_fmts=s16:channel_layouts=mono" \
    -ar 48000 -c:a pcm_s16le "$out"
}

# mix_case OUT SPEECH SFX -> stereo mix at the target loudness, limited to -2 dBFS peaks.
mix_case() {
  local out="$1" speech="$2" sfx="$3" raw="$TMP/mix-raw.wav" g
  local lim="alimiter=limit=0.794:attack=5:release=50:level=0"
  "${FF[@]}" -i "$speech" -i "$sfx" -filter_complex "amix=inputs=2:normalize=0:duration=longest" -c:a pcm_f32le "$raw"
  g="$(awk -v t="$AUDIO_TARGET" -v i="$(lufs "$raw")" 'BEGIN { printf "%.2f", t - i }')"
  "${FF[@]}" -i "$raw" -af "volume=${g}dB,$lim" -ac 2 -c:a pcm_s16le "$out"
  # The limiter lowers the level a little: one more pass with the residual error.
  g="$(awk -v t="$AUDIO_TARGET" -v i="$(lufs "$out")" -v g="$g" 'BEGIN { printf "%.2f", g + t - i }')"
  "${FF[@]}" -i "$raw" -af "volume=${g}dB,$lim" -ac 2 -c:a pcm_s16le "$out"
}

# cues_json OUT TIME_MS... -> cues file: first and last cue are hero, the types of the others cycle.
cues_json() {
  local out="$1"; shift
  local types=(appear land cut move) n=$# i=0 t sep="" ty
  {
    printf '{ "fps": %s, "target": %s, "cues": [
' "$AUDIO_FPS" "$AUDIO_TARGET"
    for t in "$@"; do
      if [ "$i" = 0 ] || [ "$i" = "$((n - 1))" ]; then ty=hero; else ty="${types[$(((i - 1) % 4))]}"; fi
      printf '%s  { "atMs": %s, "type": "%s", "hero": %s }' "$sep" "$t" "$ty" "$([ "$ty" = hero ] && echo true || echo false)"
      sep=$',
'
      i=$((i + 1))
    done
    printf '
] }
'
  } > "$out"
}

# audio_case NAME SFX_GAIN_DB CUES_FILE SFX_TIME_MS...
audio_case() {
  local name="$1" gain="$2" cues_file="$3"; shift 3
  cp "$TMP/speech.wav" "$OUT/audio/$name.speech.wav"
  sfx_stem "$OUT/audio/$name.sfx.wav" "$gain" "$@"
  mix_case "$OUT/audio/$name.wav" "$OUT/audio/$name.speech.wav" "$OUT/audio/$name.sfx.wav"
  cp "$cues_file" "$OUT/audio/$name.cues.json"
}

audio_qa_set() {
  local A="$OUT/audio" c=("${AUDIO_CUES_MS[@]}")
  mkdir -p "$A"
  # Speech stem: two `say` utterances at fixed start times (1.5 s and 7 s).
  say -v "$VOICE" -r 185 -o "$TMP/a1.aiff" "The quick brown fox jumps over the lazy dog by the river."
  say -v "$VOICE" -r 185 -o "$TMP/a2.aiff" "Editors add a short sound to every important cut in the video."
  "${FF[@]}" -i "$TMP/a1.aiff" -i "$TMP/a2.aiff" \
    -filter_complex "[0]aresample=48000,aformat=channel_layouts=mono,adelay=1500[a];[1]aresample=48000,aformat=channel_layouts=mono,adelay=7000[b];[a][b]amix=inputs=2:normalize=0:duration=longest,apad,atrim=0:$AUDIO_LEN" \
    -ar 48000 -ac 1 -c:a pcm_s16le "$TMP/speech.wav"

  cues_json "$TMP/cues-good.json" "${c[@]}"
  cues_json "$TMP/cues-close.json" "${c[0]}" "${c[1]}" "${c[2]}" "$((c[2] + 50))" "${c[3]}" "${c[4]}" "${c[5]}"

  audio_case good "$AUDIO_SFX_GAIN" "$TMP/cues-good.json" "${c[@]}"
  # cue 3 (5800 ms) is 3 frames (100 ms) late
  audio_case bad-late "$AUDIO_SFX_GAIN" "$TMP/cues-good.json" "${c[0]}" "${c[1]}" "$((c[2] + 100))" "${c[3]}" "${c[4]}" "${c[5]}"
  # cue 3 plays a sample with two hits, 250 ms apart
  audio_case bad-double-hit "$AUDIO_SFX_GAIN" "$TMP/cues-good.json" "${c[@]}" "$((c[2] + 250))"
  # two cues 50 ms apart (a fourth cue at 5850 ms)
  audio_case bad-close-cues "$AUDIO_SFX_GAIN" "$TMP/cues-close.json" "${c[0]}" "${c[1]}" "${c[2]}" "$((c[2] + 50))" "${c[3]}" "${c[4]}" "${c[5]}"
  # SFX about as loud as the speech
  audio_case bad-sfx-over-speech "$AUDIO_SFX_GAIN_LOUD" "$TMP/cues-good.json" "${c[@]}"
  # mix clipped at 0 dBFS: the good mix plus 8 dB, hard-clipped by the 16-bit conversion
  audio_case bad-clipped "$AUDIO_SFX_GAIN" "$TMP/cues-good.json" "${c[@]}"
  "${FF[@]}" -i "$A/good.wav" -af "volume=8dB" -c:a pcm_s16le "$A/bad-clipped.wav"

  # Kit set (mono 48 kHz). The beep and the noise bed start and end in 6 ms of digital silence with
  # short fades, so only the rule under test fails (the edge rule needs the first and last 5 ms quiet).
  "${FF[@]}" -f lavfi -i "sine=f=1000:d=0.3:r=48000,volume=-6dB,afade=t=in:d=0.02,afade=t=out:st=0.28:d=0.02,adelay=6,apad=pad_dur=0.006" \
    -ac 1 -c:a pcm_s16le "$A/kit-beep.wav"
  "${FF[@]}" -f lavfi -i "anoisesrc=d=2:c=white:r=48000:seed=7,volume=-12dB,afade=t=in:d=0.02,afade=t=out:st=1.98:d=0.02,adelay=6,apad=pad_dur=0.006" \
    -ac 1 -c:a pcm_s16le "$A/kit-noise-bed.wav"
  # the tap cut 20 ms in: starts mid-decay with no fade-in (a click at the first sample)
  "${FF[@]}" -i "$ASSETS/sfx/tap.wav" -af "atrim=start=0.02,asetpts=PTS-STARTPTS,volume=6dB" \
    -ac 1 -c:a pcm_s16le "$A/kit-click-start.wav"
  # two hits, 250 ms apart, in one sample
  "${FF[@]}" -i "$ASSETS/sfx/tap.wav" -i "$ASSETS/sfx/tap.wav" \
    -filter_complex "[1]adelay=250[b];[0][b]amix=inputs=2:normalize=0:duration=longest" \
    -ac 1 -c:a pcm_s16le "$A/kit-double-hit.wav"
}

if [ "${1:-}" = "--seed-media" ]; then
  seed_media
  exit 0
fi

if [ "${1:-}" = "--audio-qa" ]; then
  mkdir -p "$OUT"
  audio_qa_set
  echo "audio QA set written to $OUT/audio"
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
  -f lavfi -i "color=c=yellow:s=140x140:r=30:d=3" \
  -filter_complex "[1:v]scale=-2:900[a];[0:v][a]overlay=x=250:y=90[s1];[3:v]scale=-2:900[b];[2:v][b]overlay=x=950:y=90[s2];[5:v]format=yuv420p[box];[4:v][box]overlay=x='mod(t*500,1700)':y=450:eval=frame[s3];[s1][s2][s3]concat=n=3:v=1:a=0,format=yuv420p[v]" \
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

audio_qa_set

echo "fixtures written to $OUT"
