// GATE 5 finding: a silent video dropped for quick clips failed with "Media m_… has no audio." The
// message names the problem in the user's words (no internal id) and says what quick clips needs; the
// id stays in `details` for the CLI and logs.
import { describe, expect, it } from 'vitest';
import type { MediaItem } from '../../src/model/schema.ts';
import { transcribeMedia, type TranscribeEnv } from '../../src/stages/transcribe.ts';

const silent = {
  id: 'm_silent01',
  kind: 'video',
  path: 'media/m_silent01.mp4',
  hasAudio: false,
} as unknown as MediaItem;

describe('transcribe a video without sound', () => {
  it('says so without the internal media id', async () => {
    const err = await transcribeMedia({} as TranscribeEnv, silent).then(
      () => null,
      (e: unknown) => e as { code: string; message: string; hint: string; details?: unknown },
    );
    expect(err?.code).toBe('VALIDATION');
    expect(err?.message).toBe('This video has no sound.');
    expect(err?.message).not.toContain('m_silent01');
    expect(err?.hint).toMatch(/speech/);
    expect(err?.details).toEqual({ mediaId: 'm_silent01' });
  });
});
