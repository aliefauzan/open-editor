// Fixture projects for the app tests, made through the engine API in the test process.
import { linkSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openEngine, type Engine } from '@vox/engine';
import { REPO, STYLES } from './app.ts';

export const FIXTURES =
  process.env['VOX_FIXTURES'] ?? join(REPO, 'packages', 'engine', 'test', 'fixtures', 'out');
export const SPIKE_SRC = join(FIXTURES, 'spike-source-1080p.mp4');

export function engineAt(projectsDir: string, home: string): Engine {
  return openEngine({ projectsDir, stylesDirs: [STYLES], trustFile: join(home, 'trust.json') });
}

async function run(e: Engine, id: string, op: string, args: object) {
  const r = await e.applyOp(id, { op, args } as never, { actor: 'cli' });
  const bad = r.results.find((x) => x.status !== 'succeeded');
  if (bad) throw new Error(`${op}: ${JSON.stringify(bad.error)}`);
  return r;
}

/** An empty project with a hand-written hostile build at build/seq_hostile/ (S14) + test files. */
export async function hostileProject(e: Engine): Promise<string> {
  const p = await e.createProject('Hostile');
  const dir = join(e.projectsDir, p.id);
  mkdirSync(join(dir, 'build', 'seq_hostile'), { recursive: true });
  writeFileSync(
    join(dir, 'build', 'seq_hostile', 'index.html'),
    `<!doctype html><html><body><script>
const r = {};
try { r.parentVox = typeof parent.vox; } catch (e) { r.parentVox = 'blocked'; }
try { r.topVox = typeof window.top.vox; } catch (e) { r.topVox = 'blocked'; }
try { r.topLocation = String(window.top.location.href); } catch (e) { r.topLocation = 'blocked'; }
try { window.top.location = 'https://example.com/'; r.topNavigate = 'no error'; } catch (e) { r.topNavigate = 'blocked'; }
try { r.cookie = document.cookie; } catch (e) { r.cookie = 'blocked'; }
Promise.all([
  fetch('https://example.com/').then(() => { r.fetch = 'ok'; }, () => { r.fetch = 'blocked'; }),
  fetch('data.json').then(() => { r.readProjectFile = 'ok'; }, () => { r.readProjectFile = 'blocked'; }),
]).finally(() => parent.postMessage({ hostile: r }, '*'));
</script></body></html>`,
  );
  writeFileSync(join(dir, 'build', 'seq_hostile', 'data.json'), '{"a":1}');
  writeFileSync(join(dir, 'build', 'seq_hostile', 'clip.mp4'), Buffer.alloc(4096, 1));
  return p.id;
}

/** The 90 s spike source on V1 (+ its audio on A1) with a base/title scene over the start. */
export async function spikeProject(e: Engine): Promise<string> {
  const p = await e.createProject('Spike 90 s');
  const dir = join(e.projectsDir, p.id);
  mkdirSync(join(dir, 'media'), { recursive: true });
  const dst = join(dir, 'media', 'spike-source-1080p.mp4');
  try {
    linkSync(SPIKE_SRC, dst); // a symlink would leave the project folder (S1 rejects it)
  } catch {
    copyFileSync(SPIKE_SRC, dst);
  }
  await run(e, p.id, 'addSequence', { name: 'Main', id: 'seq_main' });
  await run(e, p.id, 'addMedia', {
    media: {
      id: 'm_spike',
      kind: 'video',
      path: 'media/spike-source-1080p.mp4',
      proxyPath: 'media/spike-source-1080p.mp4',
      audioPath: 'media/spike-source-1080p.mp4',
      durationMs: 90000,
      width: 1920,
      height: 1080,
      hasAudio: true,
      fps: { num: 30, den: 1 },
      origin: { type: 'upload' },
      tags: [],
    },
  });
  await run(e, p.id, 'placeClip', {
    sequenceId: 'seq_main',
    trackId: 'V1',
    mediaId: 'm_spike',
    startMs: 0,
    durationMs: 90000,
    withAudio: true,
    frame: { mode: 'contain' },
  });
  await run(e, p.id, 'addScene', {
    sequenceId: 'seq_main',
    trackId: 'V2',
    startMs: 0,
    durationMs: 3000,
    template: 'base/title',
    variables: { title: 'Vox Studio' },
  });
  return p.id;
}
