// The screenplay fixture generator (14b step 1): offline, 6 scenes and 6 clips, two runs give the
// same bytes (on the same machine), the clips are not in screenplay order.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  CLIP_MS,
  OUTPUT_FILES,
  SCENES,
  makeScreenplaySet,
} from '../../../../scripts/make-screenplay-set.ts';

const dirs: string[] = [];
const make = () => {
  const d = mkdtempSync(join(tmpdir(), 'vox-sp-test-'));
  dirs.push(d);
  makeScreenplaySet(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('make-screenplay-set', () => {
  test('writes the screenplay, 6 clips of 3 s with audio, tags and the expected order', () => {
    const d = make();
    expect(OUTPUT_FILES).toHaveLength(9);
    expect(
      readFileSync(join(d, 'screenplay.fountain'), 'utf8').match(/^(INT|EXT)\./gm),
    ).toHaveLength(6);
    for (const s of SCENES) {
      const probe = JSON.parse(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type',
          '-of',
          'json',
          join(d, 'clips', `${s.clip}.mp4`),
        ]).toString(),
      ) as { format: { duration: string }; streams: { codec_type: string }[] };
      expect(Number(probe.format.duration) * 1000).toBeCloseTo(CLIP_MS, -2);
      expect(probe.streams.map((x) => x.codec_type).sort()).toEqual(['audio', 'video']);
    }
    const tags = JSON.parse(readFileSync(join(d, 'tags.json'), 'utf8')) as {
      file: string;
      tags: string[];
    }[];
    expect(tags).toHaveLength(6);
    const expected = JSON.parse(readFileSync(join(d, 'expected.json'), 'utf8')) as {
      file: string;
    }[];
    expect(expected.map((e) => e.file)).not.toEqual(tags.map((t) => t.file)); // shuffled
    expect(new Set(expected.map((e) => e.file)).size).toBe(6);
  }, 120_000);

  test('two runs: byte-identical outputs', () => {
    const a = make();
    const b = make();
    for (const f of OUTPUT_FILES) expect(sha(join(a, f)), f).toBe(sha(join(b, f)));
  }, 120_000);
});
