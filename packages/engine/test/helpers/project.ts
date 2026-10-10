// Fixture projects for model/ops/history tests.
import type { Fps, MediaItem, Project, Sequence, Track } from '../../src/model/schema.ts';

export const F30: Fps = { num: 30, den: 1 };
export const NTSC: Fps = { num: 30000, den: 1001 };

export function track(id: string, items: Track['items'] = [], extra: Partial<Track> = {}): Track {
  return { id, locked: false, hidden: false, muted: false, syncLock: true, items, ...extra };
}

export function videoMedia(id = 'm_video', extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    kind: 'video',
    path: `media/${id}.mp4`,
    durationMs: 20000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    fps: NTSC,
    origin: { type: 'upload' },
    tags: [],
    transcriptPath: `transcripts/${id}.json`,
    transcriptRev: 'r1',
    ...extra,
  };
}

export function imageMedia(id = 'm_img'): MediaItem {
  return {
    id,
    kind: 'image',
    path: `media/${id}.png`,
    width: 800,
    height: 600,
    origin: { type: 'upload' },
    tags: [],
  };
}

export function audioMedia(id = 'm_aud', durationMs = 30000): MediaItem {
  return {
    id,
    kind: 'audio',
    path: `media/${id}.m4a`,
    durationMs,
    hasAudio: true,
    origin: { type: 'upload' },
    tags: [],
  };
}

export function emptySequence(id = 'seq_1', fps: Fps = F30): Sequence {
  return {
    id,
    name: 'Clip 1',
    canvas: { width: 1080, height: 1920, fps },
    styleId: 'base',
    videoTracks: [track('V1'), track('V2')],
    audioTracks: [track('A1'), track('A2')],
    captions: null,
    sfx: true,
  };
}

export function baseProject(
  seq: Sequence = emptySequence(),
  media: MediaItem[] = [videoMedia(), imageMedia(), audioMedia()],
): Project {
  return {
    schemaVersion: 2,
    id: 'p_test',
    name: 'test',
    version: 0,
    media,
    sequences: [seq],
    meta: {
      createdAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:00:00.000Z',
      sourceUrls: [],
    },
  };
}

/** A sequence with a linked V1/A1 pair, a scene on V2 and captions with overrides. */
export function richProject(fps: Fps = F30): Project {
  const seq = emptySequence('seq_1', fps);
  seq.videoTracks[0]!.items = [
    {
      id: 'it_v1',
      type: 'media',
      mediaId: 'm_video',
      startMs: 0,
      durationMs: 5000,
      inMs: 0,
      linkId: 'ln_1',
      frame: { mode: 'auto', keyframes: [{ atMs: 1000, x: 0.5, y: 0.4, scale: 1.2 }] },
    },
    {
      id: 'it_v2',
      type: 'media',
      mediaId: 'm_video',
      startMs: 5000,
      durationMs: 3000,
      inMs: 8008, // frame 240 of the 29.97 source
      linkId: 'ln_2',
    },
  ];
  seq.videoTracks[1]!.items = [
    {
      id: 'it_s1',
      type: 'scene',
      template: 'test/title',
      templateVersion: '1.0.0',
      startMs: 1000,
      durationMs: 2000,
      variables: { title: 'Hello' },
    },
  ];
  seq.audioTracks[0]!.items = [
    {
      id: 'it_a1',
      type: 'media',
      mediaId: 'm_video',
      startMs: 0,
      durationMs: 5000,
      inMs: 0,
      linkId: 'ln_1',
    },
    {
      id: 'it_a2',
      type: 'media',
      mediaId: 'm_video',
      startMs: 5000,
      durationMs: 3000,
      inMs: 8008, // frame 240 of the 29.97 source
      linkId: 'ln_2',
    },
  ];
  seq.captions = {
    enabled: true,
    sourceTrackIds: ['A1'],
    preset: 'base/plain',
    maxWords: 3,
    maxLines: 1,
    maxCharsPerLine: 18,
    gapFillMs: 400,
    position: { yPct: 75 },
    overrides: [
      { wordKey: 'm_video:r1:2', text: 'Hi there' },
      { wordKey: 'm_video:r1:0', emphasis: true },
    ],
  };
  return baseProject(seq);
}
