// R3 "External processes": argument arrays, AbortSignal kills the child, stderr tail (40 lines,
// redacted) in `cause`, missing binary → TOOL_MISSING.

import { describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import { runTool, tailLines } from '../../src/stages/media/run.ts';
import { codeOfAsync, fixture } from './helpers.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('runTool', () => {
  test('returns stdout of a successful run', async () => {
    const r = await runTool('ffprobe', [
      '-v',
      'error',
      '-of',
      'json',
      '-show_format',
      fixture('assets/media/talking-head-20s.mp4'),
    ]);
    expect(JSON.parse(r.stdout).format.duration).toBe('20.000000');
  });

  test('cancel kills the child and rejects with CANCELLED', async () => {
    const ac = new AbortController();
    let pid = 0;
    // Real-time input: runs for 61 s unless killed.
    const run = runTool(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc=d=61:s=97x53',
        '-f',
        'null',
        '-',
      ],
      { signal: ac.signal, onSpawn: (n) => (pid = n) },
    );
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    ac.abort();
    expect(await codeOfAsync(run)).toBe('CANCELLED');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(alive(pid)).toBe(false);
  });

  test('timeoutMs kills the child → TOOL_FAILED with the timeout in details', async () => {
    let pid = 0;
    const err = (await runTool(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc=d=61:s=97x53',
        '-f',
        'null',
        '-',
      ],
      { timeoutMs: 300, onSpawn: (n) => (pid = n) },
    ).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('TOOL_FAILED');
    expect(err.details).toMatchObject({ tool: 'ffmpeg', timeoutMs: 300 });
    expect(alive(pid)).toBe(false);
  });

  test('a redactor that throws does not leave the run hanging; the stderr text is dropped', async () => {
    const err = (await runTool('ffprobe', ['-v', 'error', '/nonexistent/x.mp4'], {
      redact: () => {
        throw new Error('bad redactor');
      },
    }).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('TOOL_FAILED');
    expect(err.cause).toBeUndefined();
  });

  test('stderr control characters (ANSI escapes from hostile metadata) are stripped from cause', async () => {
    const err = (await runTool('ffprobe', [
      '-v',
      'error',
      '/nonexistent/\u001b[31mred\u0007/a.mp4',
    ]).catch((e: unknown) => e)) as VoxError;
    expect(String(err.cause)).toContain('red');
    // eslint-disable-next-line no-control-regex
    expect(String(err.cause)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });

  test('an already-aborted signal never spawns', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await codeOfAsync(runTool('ffprobe', ['-version'], { signal: ac.signal }))).toBe(
      'CANCELLED',
    );
  });

  test('a missing binary → TOOL_MISSING with the path', async () => {
    const err = (await runTool('ffmpeg', ['-version'], {
      tools: { ffmpeg: '/nonexistent/vox/ffmpeg' },
    }).catch((e: unknown) => e)) as VoxError;
    expect(err).toBeInstanceOf(VoxError);
    expect(err.code).toBe('TOOL_MISSING');
    expect(err.details).toMatchObject({ tool: 'ffmpeg', path: '/nonexistent/vox/ffmpeg' });
  });

  test('a failure → TOOL_FAILED, cause = last 40 stderr lines passed through redact', async () => {
    const err = (await runTool('ffprobe', ['-v', 'error', '/nonexistent/secret-sk-123/a.mp4'], {
      redact: (s) => s.replaceAll('secret-sk-123', '[redacted]'),
    }).catch((e: unknown) => e)) as VoxError;
    expect(err.code).toBe('TOOL_FAILED');
    expect(String(err.cause)).toContain('[redacted]');
    expect(String(err.cause)).not.toContain('secret-sk-123');
    expect(err.details).toMatchObject({ tool: 'ffprobe', exitCode: 1 });
  });

  test('stdout over the cap fails the run', async () => {
    const args = [
      '-v',
      'error',
      '-of',
      'json',
      '-show_packets',
      fixture('assets/media/talking-head-20s.mp4'),
    ];
    expect(await codeOfAsync(runTool('ffprobe', args, { maxStdoutBytes: 1000 }))).toBe(
      'TOOL_FAILED',
    );
  });

  test('tailLines caps each line at 500 characters', () => {
    expect(tailLines('x'.repeat(5000))).toHaveLength(500 + 1);
  });

  test('tailLines keeps the last 40 non-empty lines', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n\n');
    const tail = tailLines(text).split('\n');
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe('line 60');
    expect(tail[39]).toBe('line 99');
  });
});
