// Style extraction in test builds (`VOX_E2E=1`, unpackaged, `VOX_E2E_AGENT=mock`; plan phase 15 step 5):
// a fixed reference instead of ingest and measure (the numbers of `style-extract-10s.mp4`, keyframes
// from a checked-in fixture image) and a mock vision model that returns a fixed description. Never
// used in a release build: index.ts only creates them when the app is not packaged.
import { join } from 'node:path';
import type { createLanguageModel, RoleModel, StyleExtractSteps } from '@vox/agent';
import { MeasurementsSchema, type StyleDescription } from '@vox/engine';

type LanguageModelV4 = ReturnType<typeof createLanguageModel>;

export const E2E_STYLE_DESCRIPTION: StyleDescription = {
  summary: 'Flat colour blocks, bold condensed titles and boxed upper-case captions.',
  fonts: {
    display: { classification: 'sans', weight: 800, case: 'upper', tags: ['condensed'] },
    body: { classification: 'sans', weight: 400, case: 'asis', tags: ['geometric'] },
    caption: { classification: 'sans', weight: 700, case: 'upper', tags: [] },
  },
  captions: {
    boxed: true,
    textColor: '#fff8e7',
    boxColor: '#141414',
    wordByWord: false,
    emphasis: 'Key words in yellow.',
  },
  motion: { frameHold: 2, entrance: 'pop', cameraMoves: [], notes: '' },
  texture: { paper: true, grain: 0.3, film: false },
  layouts: [
    { name: 'Map with pins', description: 'A route map.', closestTemplate: 'vox/map-route' },
    { name: 'Globe spin', description: 'A spinning 3D globe.', closestTemplate: null },
  ],
  imagery: [],
};

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/** The mock `vision` role: every request gets the fixed description. */
export function e2eVisionRole(): RoleModel {
  const model = {
    specificationVersion: 'v4',
    provider: 'e2e',
    modelId: 'e2e-vision',
    supportedUrls: {},
    doGenerate() {
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(E2E_STYLE_DESCRIPTION) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      });
    },
    doStream() {
      return Promise.reject(new Error('the e2e vision model does not stream'));
    },
  };
  return {
    model: model as unknown as LanguageModelV4,
    provider: { type: 'ollama', label: 'E2E mock' },
    modelId: 'e2e-vision',
    contextTokens: 128_000,
    price: { free: true },
    maxOutputTokens: 8_000,
    vision: true,
  } as RoleModel;
}

/** Ingest and measure replaced by the fixture reference (`fixtures` = packages/engine/test/fixtures). */
export function e2eStyleSteps(fixtures: string): StyleExtractSteps {
  const frame = join(fixtures, 'assets', 'faces', 'face-a.jpg');
  const color = (hex: string, share: number, lightness: number, saturation: number) => ({
    hex,
    rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
    share,
    lightness,
    saturation,
  });
  return {
    ingest: () => Promise.resolve('m_e2eref00000001'),
    measure: () =>
      Promise.resolve(
        MeasurementsSchema.parse({
          durationMs: 10_000,
          width: 1080,
          height: 1920,
          shots: [
            { startMs: 0, endMs: 2000, speaker: false },
            { startMs: 2000, endMs: 4500, speaker: true },
            { startMs: 4500, endMs: 7000, speaker: false },
            { startMs: 7000, endMs: 10_000, speaker: false },
          ],
          shotStats: { count: 4, meanMs: 2500, medianMs: 2500, p10Ms: 2000, p90Ms: 3000 },
          keyframes: [1000, 3250, 5750, 8500].map((atMs) => ({ atMs, kind: 'shot', file: frame })),
          sheets: [frame],
          palette: [
            color('#EDE8DF', 0.3, 0.9, 0.25),
            color('#F5C518', 0.24, 0.53, 0.92),
            color('#1D4FA0', 0.2, 0.37, 0.69),
            color('#D7261E', 0.17, 0.48, 0.76),
            color('#141414', 0.06, 0.08, 0),
          ],
          speakerRatio: 0.25,
          captions: {
            summary: {
              detected: true,
              captionCount: 3,
              wordsPerCaption: 3,
              yPct: 75,
              case: 'upper',
              revealShare: 0,
              medianCaptionMs: 3000,
            },
            events: [],
            staticText: [],
          },
          notes: [],
        }),
      ),
  };
}
