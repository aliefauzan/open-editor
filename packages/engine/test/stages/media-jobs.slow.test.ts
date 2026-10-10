// Engine media jobs with real ffmpeg (slow tier; needs make.sh outputs): ingest → shots through
// `engine.jobs`, on the proxy and on a `{ proxies: false }` ingest (original at 360p), cached reruns
// (no new history entry), and `engine.mediaFrames` stills (plan phase 04 steps 9, 9c).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, type Engine } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';

const fx = new URL('../fixtures/', import.meta.url).pathname;
const CUTS = `${fx}out/cuts-2shot.mp4`;
const HEAD = `${fx}assets/media/talking-head-20s.mp4`;
const truth = (): { fps: number; cutsMs: number[] } =>
  JSON.parse(readFileSync(`${fx}out/cuts-2shot.cuts.json`, 'utf8')) as { fps: number; cutsMs: number[] };

const engine = (): Engine =>
  openEngine({
    projectsDir: join(tempDir('vox-mjobs-'), 'Projects'),
    stylesDirs: [],
    templates,
    config: async () => ({}),
  });

async function run<R>(e: Engine, kind: string, args: unknown): Promise<R> {
  const info = (await e.jobs.wait(e.jobs.start(kind, args))) as JobInfo<R>;
  if (info.status !== 'done') throw new Error(`${kind}: ${JSON.stringify(info.error)}`);
  return info.result!;
}

async function ingestOne(e: Engine, input: string, proxies = true): Promise<{ pid: string; mediaId: string }> {
  if (!existsSync(CUTS)) throw new Error('Run `bash packages/engine/test/fixtures/make.sh` first.');
  const p = await e.createProject('chain');
  const r = await run<{ media: { mediaId: string }[] }>(e, 'ingest', { projectId: p.id, inputs: [input], proxies });
  return { pid: p.id, mediaId: r.media[0]!.mediaId };
}

describe('shots job (slow)', () => {
  test.each([true, false])('cuts-2shot, proxies %s: every cut within 1 frame; cached rerun', async (proxies) => {
    const e = engine();
    const { pid, mediaId } = await ingestOne(e, CUTS, proxies);
    const a = await run<{ shotsPath: string; cached: boolean; input: string; version: number }>(e, 'shots', {
      projectId: pid,
      mediaId,
    });
    expect(a).toMatchObject({ shotsPath: `shots/${mediaId}.json`, cached: false, input: proxies ? 'proxy' : 'original' });
    const shots = JSON.parse(readFileSync(join(e.projectsDir, pid, a.shotsPath), 'utf8')) as { startMs: number }[];
    const t = truth();
    const cuts = shots.slice(1).map((s) => s.startMs);
    expect(cuts).toHaveLength(t.cutsMs.length);
    t.cutsMs.forEach((c, i) => expect(Math.abs(cuts[i]! - c)).toBeLessThanOrEqual(1000 / t.fps));
    const m = (await e.getProject(pid)).media[0]!;
    expect(m.shotsPath).toBe(a.shotsPath);
    const hist = await e.history(pid);
    expect(hist.at(-1)).toMatchObject({ op: 'updateMedia' });
    const b = await run<{ cached: boolean; version: number }>(e, 'shots', { projectId: pid, mediaId });
    expect(b).toMatchObject({ cached: true, version: a.version });
    expect(await e.history(pid)).toHaveLength(hist.length);
  });
});

describe('engine.mediaFrames (slow)', () => {
  test('PNG stills at the given times, cached; outside the media is MEDIA_BOUNDS', async () => {
    const e = engine();
    const { pid, mediaId } = await ingestOne(e, HEAD);
    const [a, b] = await e.mediaFrames(pid, mediaId, [0, 5000]);
    expect(a).toMatch(/cache\/frames\/m_[a-z0-9]+-0\.png$/);
    const head = readFileSync(b!).subarray(0, 8).toString('hex');
    expect(head).toBe('89504e470d0a1a0a');
    const before = statSync(b!).mtimeMs;
    const [again] = await e.mediaFrames(pid, mediaId, [5000]);
    expect(statSync(again!).mtimeMs).toBe(before);
    await expect(e.mediaFrames(pid, mediaId, [999_999])).rejects.toMatchObject({ code: 'MEDIA_BOUNDS' });
  });
});
