// Frame cards (D-73): the engine side of `framecard`. A fake `uv` stands in for the Python tool
// (the real Apple Vision run is covered by py/tests/test_framecard.py) and counts its runs, so the
// per-still cache, the version check and the guards can be tested on any platform.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isVoxError } from '../../src/errors.ts';
import { FRAME_CARD_VERSION, frameCards, type FrameCardEnv } from '../../src/stages/framecard.ts';
import { tempDir } from '../helpers/store.ts';

const FAKE_UV = `#!/usr/bin/env node
const fs = require('node:fs');
let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  const req = JSON.parse(body);
  fs.appendFileSync(process.env.VOX_FAKE_CARD_LOG, JSON.stringify(req.images) + '\\n');
  const version = Number(process.env.VOX_FAKE_CARD_VERSION || '${String(FRAME_CARD_VERSION)}');
  const cards = req.images.map((path) =>
    path.includes('bad')
      ? { path, error: { code: 'MEDIA_UNREADABLE', message: 'cannot read the image' } }
      : {
          path,
          width: 1080,
          height: 1920,
          labels: [{ label: 'people', confidence: 0.71 }],
          text: [{ text: 'HELLO', box: { x: 0.2, y: 0.7, w: 0.6, h: 0.05 }, confidence: 1 }],
          faces: { count: 1, boxes: [{ x: 0.4, y: 0.2, w: 0.2, h: 0.1, score: 0.9 }] },
          saliency: null,
          ms: 90,
        },
  );
  process.stdout.write(JSON.stringify({ version, textLevel: 'accurate', cards }) + '\\n');
});
`;

function setup() {
  const root = tempDir('vox-cards-');
  const projectDir = join(root, 'p1');
  mkdirSync(join(projectDir, 'cache', 'frames'), { recursive: true });
  const uv = join(root, 'fake-uv.cjs');
  writeFileSync(uv, FAKE_UV);
  chmodSync(uv, 0o755);
  const log = join(root, 'runs.log');
  writeFileSync(log, '');
  process.env['VOX_FAKE_CARD_LOG'] = log;
  const env: FrameCardEnv = {
    projectDir,
    py: { uv, pyProject: '/opt/vox/py' },
    platform: 'darwin',
  };
  const still = (name: string, bytes: string) => {
    const p = join(projectDir, 'cache', 'frames', name);
    writeFileSync(p, bytes);
    return p;
  };
  const runs = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  return { root, env, still, runs };
}

describe('frameCards (D-73)', () => {
  test('a repeat call is served from the cache; a changed still is carded again', async () => {
    const { env, still, runs } = setup();
    const a = still('a.png', 'still a');
    const b = still('b.png', 'still b');
    const first = await frameCards(env, [a, b]);
    expect(first.map((c) => ('error' in c ? c.error.code : c.cached))).toEqual([false, false]);
    expect(first[0]).toMatchObject({ path: a, labels: [{ label: 'people' }], faces: { count: 1 } });
    expect(runs()).toHaveLength(1);

    const again = await frameCards(env, [b, a]);
    expect(again.map((c) => c.path)).toEqual([b, a]);
    expect(again.every((c) => 'cached' in c && c.cached)).toBe(true);
    expect(runs()).toHaveLength(1); // no tool run at all

    // the cache key is the still's content (and the card version), not its name
    writeFileSync(a, 'still a, re-rendered');
    const third = await frameCards(env, [a, b]);
    expect(third.map((c) => 'cached' in c && c.cached)).toEqual([false, true]);
    expect(runs()).toHaveLength(2);
    expect(runs()[1]).toHaveLength(1);
  });

  test('a still the tool cannot read gets an error card, which is not cached', async () => {
    const { env, still, runs } = setup();
    const bad = still('bad.png', 'garbage');
    const ok = still('ok.png', 'fine');
    const cards = await frameCards(env, [bad, ok]);
    expect(cards[0]).toEqual({
      path: bad,
      error: { code: 'MEDIA_UNREADABLE', message: 'cannot read the image' },
    });
    expect('cached' in cards[1]! && cards[1].cached).toBe(false);
    await frameCards(env, [bad, ok]);
    expect(runs()[1]).toEqual([expect.stringContaining('bad.png')]);
  });

  test('a damaged cache file is rebuilt', async () => {
    const { env, still, runs } = setup();
    const a = still('a.png', 'still a');
    await frameCards(env, [a]);
    const dir = join(env.projectDir, 'cache', 'cards');
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), '{"width":');
    const again = await frameCards(env, [a]);
    expect('cached' in again[0]! && again[0].cached).toBe(false);
    expect(runs()).toHaveLength(2);
  });

  test('a tool of another card version is refused', async () => {
    const { env, still } = setup();
    process.env['VOX_FAKE_CARD_VERSION'] = String(FRAME_CARD_VERSION + 1);
    try {
      await expect(frameCards(env, [still('a.png', 'x')])).rejects.toMatchObject({
        code: 'PY_OUTPUT_INVALID',
      });
    } finally {
      delete process.env['VOX_FAKE_CARD_VERSION'];
    }
  });

  test('only stills inside the project; off macOS it fails before any process starts', async () => {
    const { root, env, runs } = setup();
    const outside = join(root, 'outside.png');
    writeFileSync(outside, 'x');
    const err = await frameCards(env, [outside]).catch((e: unknown) => e);
    expect(isVoxError(err) && err.code).toBe('PATH_INVALID');
    await expect(frameCards({ ...env, platform: 'linux' }, [outside])).rejects.toMatchObject({
      code: 'APPLE_UNAVAILABLE',
    });
    await expect(frameCards(env, [])).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runs()).toHaveLength(0);
  });
});
