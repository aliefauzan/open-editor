#!/usr/bin/env bash
# GATE 6 side-by-side sheet (phase 14a): reference-reel crops beside frames of the four v1.1 vox templates.
# Layout: 2 rows x 2 pairs, each pair is [reference | ours] in 360x640 cells:
#   row 1: year-card | framed-portrait        row 2: newspaper | stack
# The reference reel shows the three panels of one split screen; each template is compared with its panel
# (year-card: top panel of reel-007.5s, framed-portrait and newspaper: bottom panels of reel-008.6s and
# reel-009.6s, stack: the whole split screen of reel-007.5s).
# Usage: scripts/vox-side-by-side-v11.sh <ref-frames dir> <ours dir with year-card.png, framed-portrait.png,
#        newspaper.png, stack.png (360x640 or larger, 9:16)> <out.jpg>
set -euo pipefail
ref="$1"; ours="$2"; out="$3"
fit='scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1'
f=''
i=0
add() { args+=(-i "$1"); f+="[$i:v]$2,${fit}[c$i];"; i=$((i + 1)); }
args=()
add "$ref/reel-007.5s.jpg" 'crop=540:300:0:40'
add "$ours/year-card.png" 'null'
add "$ref/reel-008.6s.jpg" 'crop=540:300:0:600'
add "$ours/framed-portrait.png" 'null'
add "$ref/reel-009.6s.jpg" 'crop=540:300:0:600'
add "$ours/newspaper.png" 'null'
add "$ref/reel-007.5s.jpg" 'null'
add "$ours/stack.png" 'null'
f+='[c0][c1][c2][c3]hstack=4[r0];[c4][c5][c6][c7]hstack=4[r1];[r0][r1]vstack=2'
ffmpeg -v error -y "${args[@]}" -filter_complex "$f" -frames:v 1 -q:v 3 "$out"
