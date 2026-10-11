---
name: vox-studio
description: Make Vox-style 9:16 paper-collage clips from a video link or file with the `vox` CLI (Vox Studio). Use when the user asks for "vox clips", "make N clips from <url>", or to style an existing Vox Studio clip. Claude is the editor; every edit goes through `vox op ... --json`.
---

# Vox Studio clipper (Claude Code skill)

You are the editor. The `vox` CLI is the engine. You cut a long video into short clips and style each one
with the `vox` style (paper collage scenes, kinetic serif statements, stats, captions, sound), the same way
the in-app agent does. No API key is needed: the model is you.

The workflow text is shared with the app. Before you start, read these files (paths from the repo root):

- `packages/agent/workflows/clipper.md` and `packages/agent/workflows/stylize.md` (the steps and the checkpoints),
- `styles/vox/guide.md` (when to use which scene, transitions, pacing, sound),
- the `template.json` of every template you plan to use: `styles/vox/templates/<name>/template.json`
  (`description`, `useWhen`, `variables`, `durationMs`, `sfxCues`). Run `vox paths --json` to find custom
  styles folders.

## Rules

- Run `vox` from the repo root as `pnpm -s exec vox <command> ... --json` (written `vox` below). Always add
  `--json` and read the JSON. Quote links (`'https://...'`): the shell breaks on `?` and `&`.
- Every edit is `vox op <project> <opName> '<args-json>' --actor agent --run-id <runId>` (camelCase op names, for
  example `addScene`). Use one `--run-id` per clip, so `vox undo <project> --run <runId>` undoes the whole clip.
  Several ops at once: `vox op <project> batch '{"ops":[{"op":"addScene","args":{...}}, ...]}'` (one undo entry).
- Ids: `<project>` is the `projectId` from `vox quick`; sequences are `seq_...`, items `it_...`, media `m_...`.
- Never put a key, token or password on a command line or in a file. Never touch the user's source video.
- Never claim you heard the sound. You only read numbers from `vox audio-qa`.
- Template and transition ids are `<style>/<name>`, for example `vox/stat`. Use only ids that exist in
  `styles/vox/templates/`. A scene never overlaps another scene on the same track (use `V2`).

## Steps

### 1. Ranges (checkpoint `ranges`)

```bash
vox doctor --quick --json
vox quick '<url or file>' --count 3 --length 30-60 --json
```

`vox quick` ingests, transcribes, finds shots and faces and picks the clips. Its JSON has `projectId`, `mediaId`
and `clips[]` (`sequenceId`, `name`, `startMs`, `endMs`, `text`). Each clip is a sequence with the speaker on
`V1` and the speech on `A1` (linked), `sourceRange` set and captions on. If the user named a count or length,
pass `--count` and `--length`. Show the user the clips (name, range, first words) in one short list.

Then do steps 2 to 8 for each clip, one clip at a time. Keep the speaker pair on `V1`/`A1` exactly as it is: never
move, trim, split or remove it in the styling steps (only step 2 changes its cuts, through `removePauses`).

### 2. Tighten (checkpoint `tighten`)

```bash
vox op <project> removePauses '{"sequenceId":"<seq>","dryRun":true}' --json
```

`results[0].report.ranges` is the list of pauses to cut (source ms, with `wordKeys`). Show the count and total
seconds. If the user asked for "tight", "no pauses" or said yes, apply all (same call without `dryRun`, with
`--actor agent --run-id <runId>`); otherwise ask once, and skip the step if the answer is no (then say
"tighten skipped by the user" in the report).

### 3. Style and captions

```bash
vox op <project> updateSequence '{"sequenceId":"<seq>","styleId":"vox"}' --actor agent --run-id <runId> --json
vox op <project> setCaptions '{"sequenceId":"<seq>","enabled":true,"preset":"vox/mono-box"}' --actor agent --run-id <runId> --json
```

### 4. Storyboard (checkpoint `storyboard`)

Read the clip's speech in sequence time (after tightening, the sequence ms are not the source ms). The project
folder is `vox paths --json` → `projectsDir`, then `<projectId>/`; the transcript is
`transcripts/<mediaId>.json` (`words[]` with `text`, `startMs`, `endMs`, `kind` in source ms). This `jq` prints
each word with its sequence ms (words that straddle a cut are dropped):

```bash
jq -r --slurpfile t transcripts/<mediaId>.json --arg seq <seq> '
  .sequences[] | select(.id==$seq) | .audioTracks[0].items | map(select(.type=="media")) as $it
  | [ $t[0].words[] | select(.kind=="word") as $w
      | ($it[] | select($w.startMs>=.inMs and $w.endMs<=.inMs+.durationMs)) as $i
      | "\($i.startMs+$w.startMs-$i.inMs) \($w.text)" ] | join("  ")' project.json
```

Split the clip into beats that follow the guide (pick the template by its rule, 1.2 to 5 s per scene, about
2.5 s on average, the speaker on screen 15 to 35 % of the runtime, the first 2 to 3 s on the speaker). Place the
beats as scenes on `V2`: `addScene` with `trackId`, `startMs`, `durationMs`, `template`, `variables` (match the
template's `variables` schema exactly: `maxLength`, required keys, enums). The engine snaps times to frames and
rejects bad variables with a hint: read the error and fix the call.

### 5. Fill (checkpoint `fill`)

Every image slot needs a media id. For each one:

```bash
vox assets search <project> "<query>" --limit 6 --json
vox assets fetch <project> <candidateId> --json
vox assets cutout <project> <mediaId> --json
```

`search` returns `candidates[]` (`id`, `title`, `license`, `width`, `height`); take a CC0, PDM or CC BY item
that matches the line and fetch it (`mediaId` in the result). `cutout` (a `paper-collage` item) returns the
cutout's new `mediaId`; use that one. If the search finds nothing usable, use the `base/placeholder` scene and
say so in the report: never leave a slot empty. `vox assets generate <project> "<prompt>"` only when an image
provider is configured (`vox doctor`).

### 6. Transitions

Follow the guide: hard cuts by default; `setTransition` with `{"template":"vox/paper-tear","durationMs":500}`
between the speaker and a collage scene. Never put a transition on the first or the last scene of a clip (the
clip has no source beyond its range), and never one that blends shots at the clip edges.

```bash
vox op <project> setTransition '{"sequenceId":"<seq>","itemId":"<it_...>","transition":{"template":"vox/paper-tear","durationMs":500}}' --actor agent --run-id <runId> --json
```

### 7. Review (checkpoint `review`)

```bash
vox frames <project> --seq <seq> --at-ms <mid of each scene, comma separated> --json
```

The result lists `{atMs, path}` PNGs. Look at them (Read the image files; to save effort tile them into one
sheet with `ffmpeg -i a.png -i b.png -filter_complex hstack=inputs=2 sheet.jpg`). Check text overflow, empty
slots and whether the template fits the line. Fix with `updateScene` (change `variables`), `moveItem` or
`trimItem`, at most two fix passes, then look again.

### 8. Sound (checkpoint `sound`)

```bash
vox audio-qa <project> --seq <seq> --json
```

Do not pass `--kit` together with `--seq`. Exit code 1 means a check failed. Read `checks[]` (`id`, `status`) and
for a failed check its `onsets` and `failures`. Fix only through edits: mute a cue with
`updateScene {"sequenceId":"<seq>","itemId":"<it_...>","sfxOff":["reveal"]}`, move or trim a scene, or swap or
drop a transition. At most two fix rounds, each followed by `vox audio-qa`. Report the numbers.

### 9. Deliver

```bash
vox render <project> --all --quality draft --out-dir <existing folder> --overwrite --json
vox credits <project>
```

`--out-dir` must already exist. Draft quality is the quick check; use `standard` or `high` when the user wants
the final files. Finish with a short report: per clip, the checkpoints (`ranges`, `tighten`, `storyboard`,
`fill`, `review`, `sound`) as met or skipped with the reason, beats placed, placeholders, frame problems still
open, audio checks still failing, the output files, and the credits for the archive images (CC BY needs credit).
To undo a clip: `vox undo <project> --run <runId>`.
