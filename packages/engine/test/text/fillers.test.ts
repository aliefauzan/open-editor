import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { FILLERS, computeWordKinds, isFiller } from '../../src/text/fillers.ts';
import type { Transcript } from '../../src/model/schema.ts';

const fixture: Transcript = JSON.parse(
  readFileSync(new URL('../fixtures/transcripts/speech-fillers.json', import.meta.url), 'utf8'),
);
const raw = (words: Transcript['words']) =>
  words
    .filter((w) => w.kind !== 'pause')
    .map(({ text, startMs, endMs }) => ({ text, startMs, endMs }));
const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

describe('word kinds (D-15)', () => {
  test('recomputes the hand-written speech-fillers transcript exactly', () => {
    expect(computeWordKinds(raw(fixture.words), { language: 'en' })).toEqual(fixture.words);
  });

  test('fillers per language, punctuation and case ignored', () => {
    expect(isFiller('Um,', 'en')).toBe(true);
    expect(isFiller('euh...', 'fr')).toBe(true);
    expect(isFiller('ähm', 'de')).toBe(true);
    expect(isFiller('think', 'en')).toBe(false);
    expect(isFiller('um', 'xx')).toBe(false); // no list for the language
    expect(Object.keys(FILLERS)).toContain('en');
    const out = computeWordKinds([w('Uh', 0, 100), w('yes', 120, 300)], { language: 'en' });
    expect(out.map((x) => x.kind)).toEqual(['filler', 'word']);
  });

  test('a language tag with a region uses the base language', () => {
    expect(computeWordKinds([w('um', 0, 100)], { language: 'en-US' })[0]!.kind).toBe('filler');
  });

  test('1-, 2- and 3-word repeats mark the earlier copy', () => {
    const one = computeWordKinds([w('the', 0, 100), w('the', 120, 200), w('cat', 220, 300)], {
      language: 'en',
    });
    expect(one.map((x) => x.kind)).toEqual(['repeat', 'word', 'word']);
    const three = computeWordKinds(
      ['we', 'should', 'go', 'we', 'should', 'go', 'now'].map((t, i) =>
        w(t, i * 100, i * 100 + 80),
      ),
      { language: 'en' },
    );
    expect(three.map((x) => x.kind)).toEqual([
      'repeat',
      'repeat',
      'repeat',
      'word',
      'word',
      'word',
      'word',
    ]);
    const triple = computeWordKinds(
      ['no', 'no', 'no'].map((t, i) => w(t, i * 100, i * 100 + 80)),
      { language: 'en' },
    );
    expect(triple.map((x) => x.kind)).toEqual(['repeat', 'repeat', 'word']);
  });

  test('a 4-word repeat is not a repeat', () => {
    const out = computeWordKinds(
      ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd'].map((t, i) => w(t, i * 100, i * 100 + 80)),
      { language: 'en' },
    );
    expect(out.every((x) => x.kind === 'word')).toBe(true);
  });

  test('pauses >= 350 ms become pseudo-words with empty text; 300 ms is no pause', () => {
    const out = computeWordKinds([w('a', 0, 100), w('b', 400, 500), w('c', 850, 900)], {
      language: 'en',
    });
    expect(out).toEqual([
      { text: 'a', startMs: 0, endMs: 100, kind: 'word' },
      { text: 'b', startMs: 400, endMs: 500, kind: 'word' },
      { text: '', startMs: 500, endMs: 850, kind: 'pause' },
      { text: 'c', startMs: 850, endMs: 900, kind: 'word' },
    ]);
  });

  test('minPauseMs is configurable and incoming pauses are recomputed', () => {
    const out = computeWordKinds(
      [
        w('a', 0, 100),
        { text: '', startMs: 100, endMs: 400, kind: 'pause' as const },
        w('b', 400, 500),
      ],
      { language: 'en', minPauseMs: 200 },
    );
    expect(out.map((x) => x.kind)).toEqual(['word', 'pause', 'word']);
  });
});
