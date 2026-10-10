# Base style

The engine's neutral root style. It is plain on purpose: other styles extend it and give it a look.
Use it when no other style is installed or the user asks for a plain edit.

## Templates

- `base/title`: a full-frame title card for the start of a section, a cover or an end card. Keep
  the headline short (a few words); the subtitle is optional.
- `base/text-overlay`: text over the footage underneath (names, places, dates, short facts). Put it
  on V2 above the video. `position` `bottom` stays above the captions.
- `base/placeholder`: marks a beat with no picture yet. Say in `label` what should go there. Never
  leave a placeholder in a finished edit without telling the user.

## Transitions

- `base/crossfade` blends two shots and needs source handles; on a clip cut at the edge of its
  source it fails with `NO_HANDLES`. Use it sparingly, for calm changes.
- `base/dip-to-black` works at any cut. Use it between topics.

## Captions

- `base/plain`: word-by-word captions, the active word bold, emphasis words larger.

## Pacing

Beats of about 3.5 s, between 1.5 s and 8 s. Mostly the speaker on screen.
