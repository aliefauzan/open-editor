#!/usr/bin/env bash
# GATE 3 side-by-side sheet (phase 07 step 12): reference frames beside frames of the vox demo.
# Layout: 3 rows x 4 cells of 360x640, each pair is [reference | ours]:
#   row 1: paper-collage | map-route
#   row 2: kinetic-serif | stat
#   row 3: mono-box caption (active + emphasis word) | serif-lower caption (active + emphasis word)
# Usage: scripts/vox-side-by-side.sh <ref-frames dir> <demo.mp4 mono-box> <demo.mp4 serif-lower> <out.jpg>
set -euo pipefail
ref="$1"; demo="$2"; demo2="$3"; out="$4"
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
f=''
for i in $(seq 0 11); do f+="[$i:v]${fit}[c$i];"; done
f+='[c0][c1][c2][c3]hstack=4[r0];[c4][c5][c6][c7]hstack=4[r1];[c8][c9][c10][c11]hstack=4[r2];'
f+='[r0][r1][r2]vstack=3'
ffmpeg -v error -y "${args[@]}" -filter_complex "$f" -frames:v 1 -q:v 3 "$out"
