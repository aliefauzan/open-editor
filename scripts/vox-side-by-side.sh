#!/usr/bin/env bash
# GATE 3 side-by-side sheet (phase 07 step 12): reference frames beside frames of the vox demo.
# Layout: 6 rows x 4 cells of 360x640, each pair is [reference | ours]:
#   row 1: paper-collage | map-route
#   row 2: kinetic-serif | stat
#   row 3: mono-box caption (active + emphasis word) | serif-lower caption (active + emphasis word)
#   row 4: word-reveal captions vs metro.media.house3 | vs attentioncompound (emphasis word)
#   row 5: inset photo card (metro) vs stat | framed inset (attentioncompound) vs paper-collage
#   row 6 (GATE 3 round 2): mixed serif italic + bold sans emphasis on grainy black vs word-reveal with
#          film-look | web headline card vs the paper-collage clipping with highlighter (bw grade)
# Rows 1-3 compare with reel.mp4 / tiktok-2.mp4, rows 4-5 with the later documentary references.
# Usage: scripts/vox-side-by-side.sh <ref-frames dir> <demo mono-box.mp4> <demo serif-lower.mp4>
#        <demo word-reveal.mp4> <out.jpg>
set -euo pipefail
ref="$1"; demo="$2"; demo2="$3"; demo3="$4"; out="$5"
fit='scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1'
args=()
add_ref() { args+=(-i "$ref/$1"); }
add_ours() { args+=(-ss "$2" -i "$1"); }
add_ref reel-000.3s.jpg;  add_ours "$demo" 12.4
add_ref reel-002.5s.jpg;  add_ours "$demo" 4.4
add_ref reel-005.2s.jpg;  add_ours "$demo" 16.0
add_ref reel-009.6s.jpg;  add_ours "$demo" 8.6
add_ref reel-004.4s.jpg;  add_ours "$demo" 1.5
add_ref tt2-033.0s.jpg;   add_ours "$demo2" 1.5
add_ref metro-3636-035.5s.jpg; add_ours "$demo3" 1.5
add_ref att-4270-029.0s.jpg;   add_ours "$demo3" 16.0
add_ref metro-3060-012.2s.jpg; add_ours "$demo" 8.6
add_ref att-4270-009.9s.jpg;   add_ours "$demo3" 12.4
add_ref att-7683-tile08.jpg;   add_ours "$demo3" 1.6
add_ref att-7690-tile03.jpg;   add_ours "$demo3" 11.8
f=''
for i in $(seq 0 23); do f+="[$i:v]${fit}[c$i];"; done
f+='[c0][c1][c2][c3]hstack=4[r0];[c4][c5][c6][c7]hstack=4[r1];[c8][c9][c10][c11]hstack=4[r2];'
f+='[c12][c13][c14][c15]hstack=4[r3];[c16][c17][c18][c19]hstack=4[r4];'
f+='[c20][c21][c22][c23]hstack=4[r5];'
f+='[r0][r1][r2][r3][r4][r5]vstack=6'
ffmpeg -v error -y "${args[@]}" -filter_complex "$f" -frames:v 1 -q:v 3 "$out"
