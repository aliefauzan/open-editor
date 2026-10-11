// The quick-clips progress bar (decision "Quick clips speed"): the import's share follows its real
// cost (a link download plus ingest is about half of the whole run, a local file about a third), and
// the bar never goes back.
import { describe, expect, it } from 'vitest';
import { importShare, steadyProgress } from '../../src/renderer/editor/quick-flow.ts';

describe('quick-clips progress', () => {
  it('a link import takes about half of the bar, a local file about a third', () => {
    expect(importShare({ kind: 'url', url: 'https://youtu.be/x' })).toBeCloseTo(0.55);
    expect(importShare({ kind: 'file' })).toBeCloseTo(0.35);
    expect(importShare({ kind: 'drop', files: [] })).toBeCloseTo(0.35);
  });

  it('steadyProgress never reports a smaller value, but passes every message', () => {
    const seen: { progress: number; message: string }[] = [];
    const report = steadyProgress((p) => seen.push(p));
    report({ progress: 0.3, message: 'Downloading' });
    report({ progress: 0.2, message: 'Making proxy' });
    report({ progress: 0.4, message: 'Making proxy' });
    expect(seen).toEqual([
      { progress: 0.3, message: 'Downloading' },
      { progress: 0.3, message: 'Making proxy' },
      { progress: 0.4, message: 'Making proxy' },
    ]);
  });
});
