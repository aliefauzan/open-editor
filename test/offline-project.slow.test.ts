// Offline fixture project, slow tier (phase 05 step 10): the script's CLI entry builds the project and
// the result renders a draft with the real HyperFrames CLI (20 s, 1080×1920, h264 + aac).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine } from '../packages/engine/src/api.ts';
import type { JobInfo } from '../packages/engine/src/jobs.ts';
import { tempDir } from '../packages/engine/test/helpers/store.ts';
import type { OfflineProject } from '../scripts/make-offline-project.ts';

const ROOT = join(import.meta.dirname, '..');

describe('make-offline-project CLI + draft render (step 10)', () => {
  test('the CLI prints the project; it renders a draft', async () => {
    const projectsDir = join(tempDir('vox-offline-'), 'Projects');
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'make-offline-project.ts'), '--projects-dir', projectsDir],
      { encoding: 'utf8' },
    );
    const r = JSON.parse(out) as OfflineProject;
    const e = openEngine({ projectsDir, stylesDirs: [join(ROOT, 'styles')], config: async () => ({}) });
    const file = join(tempDir('vox-offline-out-'), 'offline.mp4');
    const job = (await e.jobs.wait(
      e.jobs.start('render', { projectId: r.projectId, quality: 'draft', target: { file } }),
    )) as JobInfo<{ files: { path: string; durationMs: number }[] }>;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.result!.files[0]!.path).toBe(file);
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
        encoding: 'utf8',
      }),
    ) as { streams: Record<string, string | number>[]; format: { duration: string } };
    const v = probe.streams.find((s) => s['codec_type'] === 'video')!;
    expect([v['width'], v['height'], v['codec_name']]).toEqual([1080, 1920, 'h264']);
    expect(probe.streams.some((s) => s['codec_type'] === 'audio' && s['codec_name'] === 'aac')).toBe(true);
    expect(Math.abs(Number(probe.format.duration) - 20)).toBeLessThan(0.2);
    expect(e.jobs.list(r.projectId).map((j) => j.kind)).toEqual(['render']);
  }, 600_000);
});
