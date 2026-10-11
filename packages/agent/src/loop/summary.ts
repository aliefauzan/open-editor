// The run summary never says the sound is good (agent spec "Sound review"; plan D-14): no model can
// hear it. A sentence that judges the sound as good is dropped from model text before it reaches the
// summary; the check numbers and listen timecodes stay.
const SOUND = String.raw`(?:sound|sounds|audio|mix|sfx|music)`;
const GOOD = String.raw`(?:good|great|fine|clean|perfect|right|balanced|nice|ok|okay|excellent|crisp|clear)`;
const CLAIM = new RegExp(
  String.raw`\b${SOUND}\b[^.!?\n]*\b${GOOD}\b|\b${GOOD}\b[^.!?\n]*\b${SOUND}\b`,
  'i',
);

/** Drops each sentence that judges the sound as good; keeps the rest as written. */
export function scrubSoundClaims(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !CLAIM.test(s))
        .join(' '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
