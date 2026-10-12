// Phase 15: fixed measurements and a fixed vision description (what a mocked model returns) for the
// map/write/report tests. The numbers match `style-extract-10s.mp4` (make.sh): four flat shots, cuts at
// 2 s, 4.5 s and 7 s, a face in the second shot, three upper-case boxed captions at 75 % height.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFontCatalogue } from '../../src/styles/extract/catalogue.ts';
import type { StyleDescription } from '../../src/styles/extract/description.ts';
import type { MapInput, StyleSource } from '../../src/styles/extract/map.ts';
import type { Measurements } from '../../src/styles/extract/measure.ts';
import { loadStyleRegistry, type StyleRegistry } from '../../src/styles/registry.ts';
import { REPO, REPO_STYLES } from '../compile/fixture.ts';

export const FONTS = join(REPO, 'packages', 'engine', 'data', 'fonts');

const color = (hex: string, share: number, lightness: number, saturation: number) => ({
  hex,
  rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number],
  share,
  lightness,
  saturation,
});

export function measurements(keyframeFile = '/nonexistent/ref.jpg'): Measurements {
  return {
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
    keyframes: [0, 2000, 3250, 4000, 5750, 8500].map((atMs) => ({
      atMs,
      kind: 'interval' as const,
      file: keyframeFile,
    })),
    sheets: [],
    palette: [
      color('#EDE8DF', 0.3, 0.9, 0.25),
      color('#F5C518', 0.24, 0.53, 0.92),
      color('#1D4FA0', 0.2, 0.37, 0.69),
      color('#D7261E', 0.17, 0.48, 0.76),
      color('#141414', 0.06, 0.08, 0),
      color('#FFFFFF', 0.03, 1, 0),
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
  };
}

export function description(): StyleDescription {
  return {
    summary: 'Flat colour blocks, bold condensed sans titles, boxed upper-case captions.',
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
    motion: { frameHold: 2, entrance: 'pop', cameraMoves: ['slow push-in'], notes: 'Snappy.' },
    texture: { paper: true, grain: 0.3, film: false },
    layouts: [
      {
        name: 'Map with pins',
        description: 'A map with a route.',
        closestTemplate: 'vox/map-route',
      },
      { name: 'Big number', description: 'One stat.', closestTemplate: 'stat' },
      { name: '3D globe spin', description: 'A spinning globe.', closestTemplate: null },
    ],
    imagery: ['archive maps'],
  };
}

export function styleSource(reg: StyleRegistry): StyleSource {
  return {
    list: () => reg.list(),
    get: (id) => reg.get(id),
    defaultId: () => (reg.list().some((s) => s.id === 'vox') ? 'vox' : 'base'),
  };
}

/** A temp user styles folder after the repo's built-in one; nothing user-side is trusted. */
export function userStyles(): { user: string; dirs: string[]; reg: () => StyleRegistry } {
  const user = join(mkdtempSync(join(tmpdir(), 'vox-extract-')), 'styles');
  const dirs = [REPO_STYLES, user];
  return { user, dirs, reg: () => loadStyleRegistry({ stylesDirs: dirs, isTrusted: () => false }) };
}

export function mapInput(reg: StyleRegistry, over: Partial<MapInput> = {}): MapInput {
  return {
    id: 'ref-look',
    name: 'Reference look',
    reference: 'style-extract-10s.mp4',
    measurements: measurements(),
    description: description(),
    styles: styleSource(reg),
    catalogue: loadFontCatalogue(FONTS),
    ...over,
  };
}
