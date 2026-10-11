// Compile at a clip speed (engine spec "Clip speed", plan D-62): the media tags carry
// `data-playback-rate`, `data-media-start` stays the source in-point, and a range cut moves the
// in-point by the cut time × speed.
import { describe, expect, test } from 'vitest';
import type { Project } from '../../src/model/schema.ts';
import { build, mainProject } from './fixture.ts';

const index = (b: { files: Map<string, string | Uint8Array> }) =>
  b.files.get('index.html') as string;

/** mainProject with it_v1 (V1, 0–3000, in 1000) and it_a1 (A1, in 1000) at `speed`. */
function sped(speed: number): Project {
  const p = mainProject();
  const s = p.sequences[0]!;
  for (const it of [...s.videoTracks[0]!.items, ...s.audioTracks[0]!.items]) {
    if (it.id === 'it_v1' || it.id === 'it_a1') {
      if (it.type === 'media') it.speed = speed;
    }
  }
  return p;
}

describe('clip speed in compile', () => {
  test('render: the video tag gets data-playback-rate after the unchanged media start', async () => {
    const html = index(await build(sped(2), { mode: 'render' }));
    expect(html).toMatch(
      /<video id="it_v1"[^>]*data-duration="3" data-media-start="1" data-playback-rate="2"/,
    );
    // other clips stay at 1× with no attribute
    expect(html).not.toMatch(/<video id="it_v2"[^>]*data-playback-rate/);
  });

  test('preview: the audio tag of a sped sound clip gets the rate too', async () => {
    const html = index(await build(sped(0.5), { mode: 'preview' }));
    expect(html).toMatch(/<audio id="it_a1"[^>]*data-media-start="1" data-playback-rate="0\.5"/);
    expect(html).not.toMatch(/<audio id="it_m1"[^>]*data-playback-rate/);
  });

  test('1× writes no rate attribute', async () => {
    const html = index(await build(mainProject(), { mode: 'preview' }));
    expect(html).not.toContain('data-playback-rate');
  });

  test('a range cut moves the in-point by the cut time × speed', async () => {
    const b = await build(sped(2), { mode: 'render', range: { startMs: 1000, endMs: 4000 } });
    // 1000 ms cut from a 2× clip = 2000 ms of source: in 1000 → 3000
    expect(index(b)).toMatch(
      /<video id="it_v1"[^>]*data-start="0" data-duration="2" data-media-start="3" data-playback-rate="2"/,
    );
  });
});
