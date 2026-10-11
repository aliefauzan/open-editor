// Layer renderer (engine spec "Layer renderer (shared)"): chosen layers of a sequence (scenes,
// transitions, overlays, captions) rendered over a transparent background to a ProRes 4444 MOV with
// alpha by `hyperframes render --format mov`. Used by export-timeline (phase 05) and, if enabled, the
// preview pre-render cache. GATE 1 chose the HyperFrames export path (D-29), so there is no ffmpeg
// compositor here.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { BuildResult } from '../compile/compile.ts';
import { writeBuildTo } from '../compile/write.ts';
import { VoxError } from '../errors.ts';
import type { Fps } from '../model/fps.ts';

const run = promisify(execFile);

/** The pinned HyperFrames CLI. */
export function hyperframesBin(): string {
  const req = createRequire(import.meta.url);
  return join(dirname(req.resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');
}

export const fpsArg = (fps: Fps): string =>
  fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;

/** `render --format mov` arguments (MOV is always ProRes 4444 with alpha in HyperFrames). */
export function layerRenderArgs(buildDir: string, out: string, fps: Fps): string[] {
  return [
    'render',
    buildDir,
    '-o',
    out,
    '--format',
    'mov',
    '--fps',
    fpsArg(fps),
    '--strict-all',
    '--frames-cache-dir',
    'off',
  ];
}

export interface LayerRenderOptions {
  /** Where the layers build is written (replaced). */
  buildDir: string;
  /** Output `.mov`. */
  out: string;
  timeoutMs?: number;
}

/** Writes a layers build (`compile` with `layers`) and renders it to a MOV with alpha. */
export async function renderLayerBuild(
  build: BuildResult,
  opts: LayerRenderOptions,
): Promise<string> {
  if (build.mode !== 'render') {
    throw new VoxError(
      'VALIDATION',
      'Layers render from a render build',
      'Compile with mode render',
    );
  }
  const dir = writeBuildTo(build, opts.buildDir);
  mkdirSync(dirname(opts.out), { recursive: true });
  try {
    await run(process.execPath, [hyperframesBin(), ...layerRenderArgs(dir, opts.out, build.fps)], {
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 3_600_000,
    });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new VoxError(
      'TOOL_FAILED',
      `hyperframes render --format mov failed: ${(err.stderr || err.stdout || err.message || '').slice(-800)}`,
      'Check the layers build (hyperframes lint) and try again',
      { details: { tool: 'hyperframes' }, cause: e },
    );
  }
  return opts.out;
}
