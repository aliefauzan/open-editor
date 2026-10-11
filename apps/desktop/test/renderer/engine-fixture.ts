// An engine project for renderer tests: the real engine in temp folders (tests may import it; the
// renderer code under test may not, R1). Media entries need no files for ops and change records.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngine, type Engine } from '@vox/engine';
import type { Project } from '../../src/shared/project.ts';
import { STYLES } from '../helpers/app.ts';

export const KIT_STYLES = join(
  STYLES,
  '..',
  'packages',
  'engine',
  'test',
  'fixtures',
  'styles',
  'kit',
);

const TEST_STYLES = join(STYLES, '..', 'packages', 'engine', 'test', 'fixtures', 'styles');

/** The repo styles, or the engine test styles (`base`, `paper` with a geo slot, `kit` with `stack`). */
export function tempEngine(o: { testStyles?: boolean } = {}): Engine {
  const home = mkdtempSync(join(tmpdir(), 'vox-r-'));
  return openEngine({
    projectsDir: join(home, 'Projects'),
    stylesDirs: o.testStyles ? [join(TEST_STYLES, 'builtin'), join(TEST_STYLES, 'kit')] : [STYLES],
    trustFile: join(home, 'trust.json'),
  });
}

export async function op(e: Engine, id: string, name: string, args: object, version?: number) {
  const r = await e.applyOp(id, { op: name, args } as never, {
    actor: 'user',
    ...(version === undefined ? {} : { baseVersion: version }),
  });
  const bad = r.results.find((x) => x.status !== 'succeeded');
  if (bad) throw new Error(`${name}: ${JSON.stringify(bad.error)}`);
  return r;
}

/** seq_main: V1 video m_v (linked A1 audio) 0–4000 and 4000–8000, V2 base/title 0–2000. */
export async function editorProject(
  e: Engine,
  o: { titleVariables?: Record<string, unknown> } = {},
): Promise<Project> {
  const p = await e.createProject('Editor');
  await op(e, p.id, 'addSequence', { name: 'Main', id: 'seq_main' });
  await op(e, p.id, 'addMedia', {
    media: {
      id: 'm_v',
      kind: 'video',
      path: 'media/v.mp4',
      proxyPath: 'media/v.mp4',
      durationMs: 20000,
      width: 1920,
      height: 1080,
      hasAudio: true,
      fps: { num: 30, den: 1 },
      origin: { type: 'upload' },
      tags: [],
    },
  });
  await op(e, p.id, 'placeClip', {
    sequenceId: 'seq_main',
    trackId: 'V1',
    mediaId: 'm_v',
    startMs: 0,
    durationMs: 4000,
    withAudio: true,
  });
  await op(e, p.id, 'placeClip', {
    sequenceId: 'seq_main',
    trackId: 'V1',
    mediaId: 'm_v',
    startMs: 4000,
    inMs: 4000,
    durationMs: 4000,
    withAudio: true,
  });
  await op(e, p.id, 'addScene', {
    sequenceId: 'seq_main',
    trackId: 'V2',
    startMs: 0,
    durationMs: 2000,
    template: 'base/title',
    variables: o.titleVariables ?? { title: 'Hello' },
  });
  return (await e.getProject(p.id)) as unknown as Project;
}
