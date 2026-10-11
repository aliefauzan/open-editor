// writeBuildTo replaces the build folder by a swap, so an open preview never sees it missing.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BuildResult } from '../../src/compile/compile.ts';
import { writeBuildTo } from '../../src/compile/write.ts';

function build(files: Record<string, string>, links: Record<string, string> = {}): BuildResult {
  return {
    files: new Map(Object.entries(files)),
    links: new Map(Object.entries(links)),
    vendor: [],
  } as unknown as BuildResult;
}

describe('writeBuildTo', () => {
  it('replaces the folder with the new build and leaves no temp folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'vox-wb-'));
    const src = join(root, 'a.m4a');
    writeFileSync(src, 'audio');
    const dir = join(root, 'build', 'seq_a');
    writeBuildTo(build({ 'index.html': 'one', 'old.txt': 'x' }, { 'audio/m.m4a': src }), dir);
    writeBuildTo(build({ 'index.html': 'two' }, { 'audio/m.m4a': src }), dir);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('two');
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'audio', 'm.m4a'), 'utf8')).toBe('audio');
    expect(readdirSync(join(root, 'build'))).toEqual(['seq_a']);
  });

  it('a failed write keeps the previous build', () => {
    const root = mkdtempSync(join(tmpdir(), 'vox-wb-'));
    const dir = join(root, 'build', 'seq_a');
    writeBuildTo(build({ 'index.html': 'one' }), dir);
    expect(() =>
      writeBuildTo(build({ 'index.html': 'two' }, { 'm.mp4': join(root, 'gone.mp4') }), dir),
    ).toThrow(/source file is missing/);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('one');
    expect(readdirSync(join(root, 'build'))).toEqual(['seq_a']);
  });
});
