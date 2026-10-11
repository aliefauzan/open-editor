// Screenplay parser (14b step 2).
import { describe, expect, test } from 'vitest';
import { fountainText, SCENES } from '../../../../scripts/make-screenplay-set.ts';
import { estimateMs, parseScreenplay } from '../../src/screenplay/parse.ts';

describe('parseScreenplay', () => {
  test('the fixture screenplay: 6 scenes with heading, action and dialogue', () => {
    const scenes = parseScreenplay(fountainText());
    expect(scenes.map((s) => s.heading)).toEqual(SCENES.map((s) => s.heading));
    expect(scenes.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scenes[0]!.description).toBe(SCENES[0]!.action);
    expect(scenes[0]!.dialogue).toEqual([{ character: 'MARA', text: SCENES[0]!.dialogue[0]![1] }]);
    for (const s of scenes) {
      expect(s.estimatedMs).toBeGreaterThanOrEqual(2000);
      expect(s.estimatedMs % 100).toBe(0);
    }
  });

  test('title page, notes, boneyard, parentheticals and transitions are not scene text', () => {
    const scenes = parseScreenplay(
      [
        'Title: X',
        'Author: Y',
        '',
        '/* removed',
        'INT. GHOST - DAY',
        '*/',
        '.FLASHBACK - THE HARBOR',
        '',
        'Tom runs. [[check the continuity]]',
        '',
        'TOM (V.O.)',
        '(whispering)',
        'Run.',
        'Faster.',
        '',
        'CUT TO:',
        '',
        'EXT. ROAD - NIGHT',
        '',
        'Empty.',
      ].join('\n'),
    );
    expect(scenes.map((s) => s.heading)).toEqual(['FLASHBACK - THE HARBOR', 'EXT. ROAD - NIGHT']);
    expect(scenes[0]!.description).toBe('Tom runs.');
    expect(scenes[0]!.dialogue).toEqual([
      { character: 'TOM', text: 'Run.' },
      { character: 'TOM', text: 'Faster.' },
    ]);
    expect(scenes[1]!.description).toBe('Empty.');
  });

  test('plain text and markdown: `## INT. …` and `SCENE 2` headings, CRLF', () => {
    const scenes = parseScreenplay(
      '## INT. A - DAY\r\n\r\nOne.\r\n\r\nSCENE 2 - The end\r\n\r\nTwo.\r\n',
    );
    expect(scenes.map((s) => s.heading)).toEqual(['INT. A - DAY', 'SCENE 2 - The end']);
    expect(scenes.map((s) => s.description)).toEqual(['One.', 'Two.']);
  });

  test('text with no scene heading has no scenes; same text gives the same scenes', () => {
    expect(parseScreenplay('just a note\n\nanother')).toEqual([]);
    expect(parseScreenplay(fountainText())).toEqual(parseScreenplay(fountainText()));
  });

  test('duration estimate: 2.5 words/s dialogue, 3 words/s action, 2–20 s', () => {
    expect(estimateMs('one two', [])).toBe(2000);
    expect(estimateMs('', [{ character: 'A', text: Array(25).fill('w').join(' ') }])).toBe(10_000);
    expect(estimateMs(Array(900).fill('w').join(' '), [])).toBe(20_000);
  });
});
