// A project built from transcripts/speech-fillers.json (R7): one talking-head clip, linked V1 + A1.
import { readFileSync } from 'node:fs';
import {
  TranscriptSchema,
  type Fps,
  type Project,
  type Transcript,
} from '../../src/model/schema.ts';
import { baseProject, emptySequence, F30, videoMedia } from './project.ts';
import { transcriptCtx } from './ops.ts';
import { ap } from './ops.ts';

export const speechTranscript: Transcript = TranscriptSchema.parse(
  JSON.parse(
    readFileSync(new URL('../fixtures/transcripts/speech-fillers.json', import.meta.url), 'utf8'),
  ),
);

export const K = (i: number) => `m_talk:t1:${i}`;

export function speechProject(fps: Fps = F30): Project {
  const media = videoMedia('m_talk', {
    durationMs: 7200,
    fps: { num: 30, den: 1 },
    transcriptRev: 't1',
  });
  const p = baseProject(emptySequence('seq_1', fps), [media]);
  return ap(
    p,
    'placeClip',
    { sequenceId: 'seq_1', trackId: 'V1', mediaId: 'm_talk', startMs: 0 },
    speechCtx(),
  );
}

export const speechCtx = () => transcriptCtx({ m_talk: speechTranscript });
