// Which H.264 encoder the CFR copy uses (decision "CFR copy speed"): `h264_videotoolbox` when the
// ffmpeg build lists it, else libx264. Detected once per ffmpeg binary (`ffmpeg -hide_banner
// -encoders`) and cached for the life of the process; a hardware encode that fails switches that
// ffmpeg to libx264 (e.g. a build that lists the encoder on a machine or VM without the hardware).
// The argv builders stay pure: callers pass the choice into `cfrCopyArgs`.

import type { H264Encoder } from './proxy.ts';
import { runTool, type RunOptions } from './run.ts';

const ENCODER_LINE = /^\s*[VAS][.A-Z]{5}\s+(\S+)/;

/** Encoder names from `ffmpeg -encoders` (lines like ` V....D libx264  …`; the legend is skipped). */
export function parseEncoders(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = ENCODER_LINE.exec(line);
    if (m && m[1] !== '=') names.add(m[1] as string);
  }
  return names;
}

const cache = new Map<string, Promise<H264Encoder>>();
const keyOf = (ro: RunOptions): string => ro.tools?.ffmpeg ?? 'ffmpeg';

/** The H.264 encoder for CFR copies with this ffmpeg (never throws: libx264 when unsure). */
export function h264Encoder(ro: RunOptions = {}): Promise<H264Encoder> {
  const key = keyOf(ro);
  let hit = cache.get(key);
  if (!hit) {
    hit = runTool('ffmpeg', ['-hide_banner', '-encoders'], {
      ...(ro.tools ? { tools: ro.tools } : {}),
      ...(ro.env ? { env: ro.env } : {}),
      timeoutMs: 20_000,
    }).then(
      ({ stdout }): H264Encoder =>
        parseEncoders(stdout).has('h264_videotoolbox') ? 'videotoolbox' : 'libx264',
      (): H264Encoder => 'libx264',
    );
    cache.set(key, hit);
  }
  return hit;
}

/** A hardware encode failed with this ffmpeg: use libx264 from now on. */
export function markHardwareFailed(ro: RunOptions = {}): void {
  cache.set(keyOf(ro), Promise.resolve('libx264'));
}

/** Tests only. */
export function resetEncoderCache(): void {
  cache.clear();
}
