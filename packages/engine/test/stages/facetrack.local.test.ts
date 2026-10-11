import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  DetectionsSchema,
  applyClipFraming,
  buildTrackPath,
  sampleKeyframes,
  type Detections,
} from '../../src/stages/facetrack.ts';
import { detectShots } from '../../src/stages/shots.ts';

// Local tier (R3, D-16): real MediaPipe + Vision detections from `vox_py.facetrack` on the generated
// fixtures, fed into the TS path builder (phase 04 step 12c on the real files). Needs make.sh outputs
// (built here when missing) and the pinned face model (`VOX_TEST_MODELS_DIR` or `py/cache/models`,
// fetched once by the Python tool's own pinned-URL + SHA-256 download when missing).
const repo = new URL('../../../../', import.meta.url).pathname;
const fx = `${repo}packages/engine/test/fixtures/`;
const modelsDir = process.env['VOX_TEST_MODELS_DIR'] ?? `${repo}py/cache/models`;
const model = `${modelsDir}/blaze_face_full_range.tflite`;
const VERTICAL = { width: 1080, height: 1920 };

function uvPython(args: string[], input?: string): string {
  return execFileSync(
    'uv',
    ['run', '--frozen', '--project', `${repo}py`, 'python', '-I', ...args],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    },
  );
}

function detect(name: string): Detections {
  const out = uvPython(
    ['-m', 'vox_py.facetrack'],
    JSON.stringify({ videoPath: `${fx}out/${name}`, faceModelPath: model }),
  );
  return DetectionsSchema.parse(JSON.parse(out));
}

describe('facetrack path on real detections', () => {
  beforeAll(() => {
    if (!['cuts-2shot.mp4', 'podcast-2face.mp4'].every((n) => existsSync(`${fx}out/${n}`))) {
      execFileSync('bash', [`${fx}make.sh`], { stdio: 'inherit' });
    }
    if (!existsSync(model)) {
      uvPython([
        '-c',
        'import sys; from pathlib import Path; from vox_py import facetrack; facetrack.ensure_face_model(Path(sys.argv[1]))',
        modelsDir,
      ]);
    }
  }, 600_000);

  test('cuts-2shot: no drift across a cut; auto uses saliency on the no-face shot', async () => {
    const truth = JSON.parse(readFileSync(`${fx}out/cuts-2shot.cuts.json`, 'utf8')) as {
      durationMs: number;
    };
    const shots = await detectShots({
      input: `${fx}out/cuts-2shot.mp4`,
      durationMs: truth.durationMs,
    });
    const det = detect('cuts-2shot.mp4');
    const ft = buildTrackPath(det, shots, { mode: 'facetrack', aspect: VERTICAL });
    const auto = buildTrackPath(det, shots, { mode: 'auto', aspect: VERTICAL });
    expect(ft.shots.map((s) => s.subject)).toEqual(['face', 'face', 'centre']);
    expect(auto.shots.map((s) => s.subject)).toEqual(['face', 'face', 'saliency']);
    const [, s2, s3] = shots;
    const firstAt = (t: number) => ft.keyframes.find((k) => k.atMs >= t);
    expect(firstAt(s2!.startMs)?.atMs).toBe(s2!.startMs);
    expect(firstAt(s2!.startMs)?.x).toBeGreaterThan(0.5); // face-b on the right, from the cut on
    expect(sampleKeyframes(ft.keyframes, s2!.startMs - 1).x).toBeLessThan(0.5); // face-a held to the cut
    expect(sampleKeyframes(ft.keyframes, s3!.startMs - 1).x).toBeGreaterThan(0.5);
    // a pin near the end of shot 1 never leaks into shot 2
    const k = applyClipFraming(auto, {
      inMs: 0,
      durationMs: truth.durationMs,
      keyframes: [{ atMs: s2!.startMs - 50, x: 0.2, y: 0.5, scale: 1 }],
    });
    expect(sampleKeyframes(k, s2!.startMs).x).toBeCloseTo(
      sampleKeyframes(auto.keyframes, s2!.startMs).x,
      3,
    );
  }, 600_000);

  test('podcast-2face: the 0.5 s growth does not switch, the 1.5 s growth does', () => {
    const det = detect('podcast-2face.mp4');
    const path = buildTrackPath(det, [], { mode: 'facetrack', aspect: VERTICAL });
    const sw = path.shots[0]?.switchesAtMs ?? [];
    expect(sw).toHaveLength(1);
    expect(sw[0]).toBeGreaterThanOrEqual(8000);
    expect(sw[0]).toBeLessThanOrEqual(8500);
    expect(sampleKeyframes(path.keyframes, 5000).x).toBeLessThan(0.5);
    expect(sampleKeyframes(path.keyframes, 11999).x).toBeGreaterThan(0.5);
    // locked: subjects sit still, so each shot is one static crop
    const locked = buildTrackPath(
      det,
      [
        { startMs: 0, endMs: 6000 },
        { startMs: 6000, endMs: 12000 },
      ],
      {
        mode: 'facetrack',
        aspect: VERTICAL,
        stability: 'locked',
        faceIndex: 0,
      },
    );
    expect(locked.shots.map((s) => s.stability)).toEqual(['locked', 'locked']);
    expect(locked.keyframes).toHaveLength(4);
  }, 600_000);
});
