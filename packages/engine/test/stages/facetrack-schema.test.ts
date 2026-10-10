import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { DetectionsSchema } from '../../src/stages/facetrack.ts';
import { cuts2shot, podcast } from './facetrack-synth.ts';

// The TS side and the Python side agree on the detections file (D-21, phase 04 step 3):
// the zod schema accepts exactly what py/tests/schemas/facetrack.result.json accepts on these cases.
const schemaUrl = new URL('../../../../py/tests/schemas/facetrack.result.json', import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(JSON.parse(readFileSync(schemaUrl, 'utf8')) as object);

const cases: [string, unknown][] = (() => {
  const ok = cuts2shot();
  const c = (f: (d: ReturnType<typeof cuts2shot>) => void) => {
    const d = structuredClone(ok);
    f(d);
    return d;
  };
  return [
    ['cuts-2shot synthetic', ok],
    ['podcast synthetic', podcast([[3000, 3500]])],
    ['no samples', c((d) => (d.samples = []))],
    ['box out of range', c((d) => (d.samples[0]!.faces[0]!.w = 1.2))],
    ['negative atMs', c((d) => (d.samples[0]!.atMs = -1))],
    ['fractional atMs', c((d) => (d.samples[0]!.atMs = 1.5))],
    ['extra sample key', c((d) => Object.assign(d.samples[0]!, { id: 1 }))],
    ['extra box key', c((d) => Object.assign(d.samples[0]!.faces[0]!, { label: 'a' }))],
    [
      'missing saliency',
      c((d) => delete (d.samples[0] as Partial<(typeof d.samples)[0]>).saliency),
    ],
    ['bad sha256', c((d) => (d.faceModel.sha256 = 'A'.repeat(64)))],
    ['zero sampleFps', c((d) => (d.sampleFps = 0))],
    ['zero width', c((d) => (d.width = 0))],
    ['empty model name', c((d) => (d.faceModel.name = ''))],
  ];
})();

describe('DetectionsSchema agrees with the Python JSON Schema', () => {
  test.each(cases)('%s', (_name, value) => {
    expect(DetectionsSchema.safeParse(value).success).toBe(validate(value));
  });

  test('the good cases are accepted by both', () => {
    expect(validate(cases[0]![1])).toBe(true);
    expect(validate(cases[1]![1])).toBe(true);
  });
});
