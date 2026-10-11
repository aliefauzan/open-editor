// The run summary never says the sound is good (plan D-14), but it keeps every sentence that reports a
// problem or a number: negations, FAIL results and measurements stay as the model wrote them.
import { describe, expect, test } from 'vitest';
import { scrubSoundClaims } from '../../src/loop/summary.ts';

describe('scrubSoundClaims', () => {
  test('drops a sentence that judges the sound as good', () => {
    expect(scrubSoundClaims('Placed 2 scenes. The mix sounds great.')).toBe('Placed 2 scenes.');
    expect(scrubSoundClaims('The audio is clean and the mix sounds great.')).toBe('');
  });

  test('keeps negative, failing and measured sentences', () => {
    const kept = [
      'The audio is not clean yet.',
      'The mix is no good at the cut.',
      "The sound isn't balanced after the stat.",
      'Audio QA FAIL: the mix still needs fine spacing.',
      'Spacing failed; the sfx cue is fine elsewhere.',
      'The mix is clean at -14.2 LUFS.',
    ];
    for (const s of kept) expect(scrubSoundClaims(s), s).toBe(s);
  });
});
