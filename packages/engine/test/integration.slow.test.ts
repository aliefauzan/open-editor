// Engine integration (phase 05 step 9; engine spec "Testing"): fixture → ingest (local file) →
// transcribe → two linked clips + one `base/title` scene → captions → draft render with the real
// HyperFrames CLI and the audio mux → duration, 1080×1920, AAC audio, 3 non-blank frames, SRT export.
// Transcribe is the real mlx-whisper job when its weights are in the Hugging Face cache (the M5,
// outside CI); otherwise the checked-in mlx-whisper output for the same file is seeded (R7), as
// the transcribe stage itself is local tier (phase 04).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, resolveToolPaths, type Engine } from '../src/api.ts';
import type { JobInfo } from '../src/jobs.ts';
import type { Transcript } from '../src/model/schema.ts';
import { WHISPER_REPO } from '../src/stages/transcribe.ts';
import { tempDir } from './helpers/store.ts';
import { HEAD, HEAD_TRANSCRIPT, REPO, REPO_STYLES } from './export/project.ts';

const hfHub = join(process.env['HF_HOME'] ?? join(homedir(), '.cache', 'huggingface'), 'hub');
const realTranscribe =
  !process.env['CI'] && existsSync(join(hfHub, `models--${WHISPER_REPO.replace('/', '--')}`));

async function job<T>(e: Engine, kind: string, args: unknown): Promise<T> {
  const info = (await e.jobs.wait(e.jobs.start(kind, args))) as JobInfo<T>;
  if (info.status !== 'done') throw new Error(`${kind}: ${JSON.stringify(info.error)}`);
  return info.result!;
}

function probe(file: string) {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  ) as { streams: Record<string, string | number>[]; format: { duration: string } };
  return {
    v: out.streams.find((s) => s['codec_type'] === 'video')!,
    a: out.streams.find((s) => s['codec_type'] === 'audio'),
    dur: Number(out.format.duration),
  };
}

/** Spread (standard deviation) of one frame's luma at `sec`, at 64×114. */
function lumaSpread(file: string, sec: number): number {
  const px = [
    ...execFileSync(
      'ffmpeg',
      ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'scale=64:114,format=gray', '-f', 'rawvideo', '-'],
      { maxBuffer: 1 << 20 },
    ),
  ]; // prettier-ignore
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  return Math.sqrt(px.reduce((a, b) => a + (b - mean) ** 2, 0) / px.length);
}

describe('engine integration (step 9)', () => {
  test(`fixture → ingest → transcribe (${realTranscribe ? 'mlx-whisper' : 'seeded'}) → edit → draft render + SRT`, async () => {
    const toolsDir =
      process.env['VOX_TOOLS_DIR'] ?? join(homedir(), 'Library', 'Application Support', 'Vox Studio', 'tools');
    const e = openEngine({
      projectsDir: join(tempDir('vox-integration-'), 'Projects'),
      stylesDirs: [REPO_STYLES],
      tools: resolveToolPaths({ toolsDir, env: process.env, pyProject: join(REPO, 'py') }),
      config: async () => ({}),
    });
    const p = await e.createProject('Integration');
    const ing = await job<{ media: { mediaId: string }[] }>(e, 'ingest', { projectId: p.id, inputs: [HEAD] });
    const mediaId = ing.media[0]!.mediaId;
    const op = async (o: unknown) => {
      const r = await e.applyOp(p.id, o as never, { actor: 'cli' });
      expect(r.results.every((x) => x.status === 'succeeded'), JSON.stringify(r.results)).toBe(true);
    };
    if (realTranscribe) {
      await job(e, 'transcribe', { projectId: p.id, mediaId });
    } else {
      const dir = join(e.projectsDir, p.id);
      mkdirSync(join(dir, 'transcripts'), { recursive: true });
      copyFileSync(HEAD_TRANSCRIPT, join(dir, 'transcripts', `${mediaId}.json`));
      await op({
        op: 'updateMedia',
        args: { mediaId, patch: { transcriptPath: `transcripts/${mediaId}.json`, transcriptRev: 'seed' } },
      });
    }
    const m = (await e.getProject(p.id)).media.find((x) => x.id === mediaId)!;
    const t = JSON.parse(readFileSync(join(e.projectsDir, p.id, m.transcriptPath!), 'utf8')) as Transcript;
    const words = t.words.filter((w) => w.kind === 'word');
    expect(words.length).toBeGreaterThan(20);

    await op({ op: 'addSequence', args: { name: 'Main', id: 'seq_main', styleId: 'base' } });
    const place = (startMs: number, inMs: number, durationMs: number) =>
      op({
        op: 'placeClip',
        args: { sequenceId: 'seq_main', trackId: 'V1', mediaId, startMs, inMs, durationMs, withAudio: true, frame: { mode: 'cover' } },
      });
    await place(0, 0, 4000);
    await place(4000, 9000, 3000);
    await op({
      op: 'addScene',
      args: { sequenceId: 'seq_main', trackId: 'V2', startMs: 500, durationMs: 1500, template: 'base/title', variables: { title: 'Vox' } },
    });
    await op({ op: 'setCaptions', args: { sequenceId: 'seq_main', enabled: true } });

    const out = tempDir('vox-integration-out-');
    const r = await job<{ files: { path: string }[] }>(e, 'render', {
      projectId: p.id,
      quality: 'draft',
      target: { dir: out },
    });
    const file = r.files[0]!.path;
    expect(file).toBe(join(out, 'Integration-Main.mp4'));
    const pr = probe(file);
    expect([pr.v['width'], pr.v['height'], pr.v['codec_name']]).toEqual([1080, 1920, 'h264']);
    expect(pr.a?.['codec_name']).toBe('aac');
    expect(pr.dur).toBeGreaterThan(6.9);
    expect(pr.dur).toBeLessThan(7.15);
    for (const t of [1, 3.5, 6]) expect(lumaSpread(file, t), `frame at ${t} s`).toBeGreaterThan(8);

    const srt = await job<{ path: string }>(e, 'exportCaptions', { projectId: p.id, format: 'srt', target: { dir: out } });
    const text = readFileSync(srt.path, 'utf8');
    expect(text).toMatch(/^1\n00:00:00,\d{3} --> 00:00:0\d,\d{3}\n\S/);
    const chunks = await e.captions(p.id, 'seq_main');
    expect(text.trim().split('\n\n')).toHaveLength(chunks.length);
  }, 900_000);
});
