---
name: stylize
allowedTools:
  [
    get_transcript,
    get_template,
    add_scene,
    update_scene,
    move_item,
    trim_item,
    set_transition,
    search_images,
    fetch_image,
    cutout,
    view_frames,
    check_audio,
  ]
roles: [editor, fast, vision]
checkpoints: [storyboard, fill, review, sound]
---

# Stylize

You add the style's beats to one existing clip (the sequence in the current state). The clip's picture is
on `V1` (framing `auto`) and its speech on `A1`, linked; it may be a run of linked pairs with jump cuts.
Keep that pair exactly as it is: never move, trim, split, remove or place it again. Keep the sequence's
`sourceRange` and the user's caption edits. The workflow has already switched the sequence to the style and
its default caption preset.

1. Storyboard. Read the transcript (`get_transcript` with the sequence id: it reads only the clip's span,
   one `[startMs-endMs] text` line per sentence in sequence ms) and the templates you plan to use
   (`get_template`). Split the clip into beats that follow the style guide's pacing. Scene beats are
   scenes on `V2` that cover the speaker; speaker beats are the gaps between them. Pick each scene's
   template by what its line says (the guide's "Choosing a scene") and use a mix: at most two scenes of
   one template in a clip. Layout `full-collage`
   keeps the speaker share near the guide's minimum; `hybrid` keeps it near the maximum. Never let two
   scenes on one track overlap.
2. Fill. For every image or cutout slot: `search_images`, then `fetch_image` on the best candidate, then
   `cutout` when the slot is a cutout. If the search finds nothing usable, use the `base/placeholder`
   scene and say so in your summary; never leave a slot empty.
3. Transitions. Follow the guide's "Transitions" and "Sound": prefer hard cuts; use a transition only where
   its sound is the accent. At the clip's edges (the first and the last scene) use only cover-style
   transitions (ones that do not blend the two shots): quick clips have no source beyond their range.
4. Review. Call `view_frames` at each scene's midpoint; it returns a text card per frame (labels,
   on-screen text with its position, faces, salient region). Fix frames with health flags first, then
   what the cards show against the guide (text overflow, empty slots, the wrong template for the line).
   Call it again with `detail: "pixels"` only for a judgment the cards cannot make (framing, caption
   look, colour). At most two fix passes.
5. Sound. Call `check_audio`. Fix each FAIL only through edits: move or trim a scene, swap or drop a
   transition, or mute a cue with `update_scene { sfxOff }`. At most two fix rounds, each followed by
   `check_audio`. You cannot hear the result: never say the sound is good. Report the numbers.

End with a short summary: beats placed, placeholders, skipped steps, frame-health flags still open, and
the audio checks still failing.
