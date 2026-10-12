#!/usr/bin/env bash
# GATE 6 side-by-side sheet (phase 14a): reference-reel panels beside the four v1.1 vox templates.
# Round 3 layout (D-71), 2293x1440:
#   left, 4 rows of [reel panel | our panel | our full 9:16 still]; panels are 640x360 crops of the
#   16:9 bands of the reel's split screen and of our `stack` (panels at x 60, 960x540 in 1080x1920):
#     row 1: year-card            reel 8.6 s top band     vs stack.png top band
#     row 2: framed-portrait      reel 7.5 s bottom band  vs stack-portrait.png bottom band
#     row 3: framed-portrait gone reel 8.6 s bottom band  vs stack-portrait-gone.png bottom band
#     row 4: newspaper            reel 9.6 s bottom band  vs stack.png bottom band
#   right, 2 rows of [reel frame | our stack] at 405x720: reel 9.6 s vs stack.png, reel 8.6 s vs
#   stack-portrait-gone.png.
# Usage: scripts/vox-side-by-side-v11.sh <reel.mp4> <ours dir from scripts/vox-gate6-r3.ts> <out.jpg>
set -euo pipefail
reel="$1"; ours="$2"; out="$3"
# band tops in the reel (measured: 102, 663, 1218) and in our stack (103, 655, 1207)
band() { echo "crop=960:540:60:$1,scale=640:360,setsar=1"; }
tall='scale=203:360,setsar=1'
full='scale=405:720,setsar=1'
args=(
  -ss 8.6 -i "$reel" -ss 7.5 -i "$reel" -ss 9.6 -i "$reel"
  -i "$ours/stack.png" -i "$ours/stack-portrait.png" -i "$ours/stack-portrait-gone.png"
  -i "$ours/year-card.png" -i "$ours/framed-portrait.png" -i "$ours/framed-portrait-gone.png"
  -i "$ours/newspaper.png"
)
f="[0:v]split=3[r86a][r86b][r86c];[1:v]split=1[r75a];[2:v]split=2[r96a][r96b];"
f+="[3:v]split=3[sa][sb][sc];[4:v]null[pa];[5:v]split=2[ga][gb];"
f+="[r86a]$(band 102)[a0];[sa]$(band 103)[a1];[6:v]${tall}[a2];"
f+="[r75a]$(band 1218)[b0];[pa]$(band 1207)[b1];[7:v]${tall}[b2];"
f+="[r86b]$(band 1218)[c0];[ga]$(band 1207)[c1];[8:v]${tall}[c2];"
f+="[r96a]$(band 1218)[d0];[sb]$(band 1207)[d1];[9:v]${tall}[d2];"
f+="[a0][a1][a2]hstack=3[ra];[b0][b1][b2]hstack=3[rb];[c0][c1][c2]hstack=3[rc];[d0][d1][d2]hstack=3[rd];"
f+="[ra][rb][rc][rd]vstack=4[left];"
f+="[r96b]${full}[e0];[sc]${full}[e1];[r86c]${full}[f0];[gb]${full}[f1];"
f+="[e0][e1]hstack=2[re];[f0][f1]hstack=2[rf];[re][rf]vstack=2[right];[left][right]hstack=2"
ffmpeg -v error -y "${args[@]}" -filter_complex "$f" -frames:v 1 -q:v 3 "$out"
