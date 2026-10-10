import { describe, expect, test } from 'vitest';
import {
  SCHEMA_VERSION,
  parseProject,
  ProjectSchema,
  TranscriptSchema,
} from '../../src/model/schema.ts';
import { newId } from '../../src/model/ids.ts';
import { readFileSync } from 'node:fs';
import { baseProject, richProject, videoMedia } from '../helpers/project.ts';

const clone = <T>(v: T): T => structuredClone(v);

describe('project.json schema', () => {
  test('schemaVersion is 2 and a rich fixture project parses', () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(parseProject(richProject())).toEqual(richProject());
  });

  test('every D-15 field validates', () => {
    const p = richProject();
    p.media[0] = videoMedia('m_video', {
      fps: { num: 90000, den: 1 },
      vfr: true,
      cfrPath: 'media/m_video.cfr.mp4',
      loudness: { integratedLufs: -18.2, truePeakDb: -1.5 },
      shotsPath: 'shots/m_video.json',
    });
    const v1 = p.sequences[0]!.videoTracks[0]!.items[0]!;
    if (v1.type !== 'media') throw new Error();
    v1.frame = {
      mode: 'auto',
      stability: 'locked',
      trackSpeed: 'fast',
      keyframes: [{ atMs: 0, x: 0.5, y: 0.5, scale: 1 }],
    };
    const a1 = p.sequences[0]!.audioTracks[0]!.items[0]!;
    if (a1.type !== 'media') throw new Error();
    a1.denoise = 'strong';
    p.sequences[0]!.captions!.autoEmphasis = true;
    expect(() => parseProject(p)).not.toThrow();
  });

  test('load rejects unknown fields at every level', () => {
    const top = clone(baseProject()) as Record<string, unknown>;
    top['extra'] = 1;
    expect(() => parseProject(top)).toThrow(/VALIDATION|Unrecognized/);
    const deep = richProject() as unknown as {
      sequences: { videoTracks: { items: Record<string, unknown>[] }[] }[];
    };
    deep.sequences[0]!.videoTracks[0]!.items[0]!['speed'] = 2;
    expect(() => parseProject(deep)).toThrow();
  });

  test('canvas fps must be in the fixed set; media fps may be any rate', () => {
    const p = baseProject();
    p.sequences[0]!.canvas.fps = { num: 29, den: 1 };
    expect(() => parseProject(p)).toThrow();
    const q = baseProject();
    q.media[0]!.fps = { num: 90000, den: 3001 };
    expect(() => parseProject(q)).not.toThrow();
  });

  test('times are integers', () => {
    const p = richProject();
    p.sequences[0]!.videoTracks[0]!.items[0]!.startMs = 0.5;
    expect(() => parseProject(p)).toThrow();
  });

  test('ids are prefixed; track ids are V<n>/A<n>', () => {
    const p = baseProject();
    p.media[0]!.id = 'video';
    expect(() => parseProject(p)).toThrow();
    const q = baseProject();
    q.sequences[0]!.videoTracks[0]!.id = 'A1';
    expect(() => parseProject(q)).toThrow();
  });

  test('media paths follow the lexical path rule', () => {
    for (const bad of ['../x.mp4', '/etc/passwd', 'media/%2e%2e/x', 'a\0b']) {
      const p = baseProject();
      p.media[0]!.path = bad;
      expect(() => parseProject(p), bad).toThrow();
    }
  });

  test('newId is prefixed, short and sorts by creation', () => {
    const a = newId('it_');
    const b = newId('it_');
    expect(a).toMatch(/^it_[0-9a-z]{12}$/);
    expect(a < b || a.slice(0, 11) === b.slice(0, 11)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => newId('m_'))).size).toBe(1000);
  });

  test('ProjectSchema is exported for tools', () => {
    expect(ProjectSchema.safeParse(baseProject()).success).toBe(true);
  });
});

describe('transcript file', () => {
  test('the hand-written speech-fillers transcript parses', () => {
    const t = JSON.parse(
      readFileSync(new URL('../fixtures/transcripts/speech-fillers.json', import.meta.url), 'utf8'),
    );
    expect(TranscriptSchema.parse(t).words).toHaveLength(21);
  });

  test('a word kind outside the four kinds is rejected', () => {
    expect(() =>
      TranscriptSchema.parse({
        language: 'en',
        words: [{ text: 'a', startMs: 0, endMs: 1, kind: 'noise' }],
        speechRegions: [],
      }),
    ).toThrow();
  });
});
