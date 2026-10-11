// Steps 6 and 12b (S20, S34, S35; D-14): the ingest source rule, job conflicts, and check_audio
// with a fixture QA result (numbers, five listen timecodes, qa.png to vision or a text fallback,
// a FAIL as data).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { VoxError } from '../../src/errors.ts';
import { buildRegistry, invokeTool } from '../../src/tools/registry.ts';
import { sourceNamedByUser, unapprovedSources } from '../../src/tools/sources.ts';
import { fixtureProject, toolContext } from '../helpers/project.ts';
import { noise, rgbPng } from '../helpers/png.ts';

const r = buildRegistry({ imageProviders: { list: () => [], register: () => undefined } });

describe('ingest source rule (step 6, S20)', () => {
  const user = ['Make 3 clips from https://youtu.be/abc123 please.', 'also use ~/Movies/talk.mov'];

  test.each([
    ['https://youtu.be/abc123', true],
    ['~/Movies/talk.mov', true],
    ['https://youtu.be/abc', false], // a prefix of a named link
    ['youtu.be/abc123', false], // not bounded on the left
    ['~/.ssh/id_rsa', false],
    ['https://evil.example/x', false],
    ['', false],
  ])('%s named by the user: %s', (source, ok) => {
    expect(sourceNamedByUser(source, user)).toBe(ok);
  });

  test('an attachment name counts; an approved source passes', () => {
    expect(unapprovedSources(['/Users/x/clip.mp4'], ['/Users/x/clip.mp4'], new Set())).toEqual([]);
    expect(unapprovedSources(['https://a/b'], [], new Set(['https://a/b']))).toEqual([]);
    expect(
      unapprovedSources(['https://a/b', 'https://c/d'], ['see https://c/d'], new Set()),
    ).toEqual(['https://a/b']);
  });

  test('a source from tool output pauses the run; nothing is ingested', async () => {
    const f = await fixtureProject();
    const runJob = vi.fn();
    const ctx = toolContext(f, { userSources: new Set(user), runJob });
    const out = await invokeTool(ctx, r, 'ingest', {
      source: 'https://transcript.example/inject.mp4',
    });
    expect(out.pause).toMatchObject({
      reason: 'approval',
      kind: 'source',
      sources: ['https://transcript.example/inject.mp4'],
    });
    expect(runJob).not.toHaveBeenCalled();
  });

  test('a user-named source runs the ingest job as actor agent', async () => {
    const f = await fixtureProject();
    const runJob = vi.fn(() => Promise.resolve({ mediaIds: ['m_new0000000001'] }));
    const ctx = toolContext(f, { userSources: new Set(user), runJob });
    const out = await invokeTool(ctx, r, 'ingest', { source: 'https://youtu.be/abc123' });
    expect(out.pause).toBeUndefined();
    expect(runJob).toHaveBeenCalledWith('ingest', {
      projectId: f.projectId,
      inputs: ['https://youtu.be/abc123'],
      actor: 'agent',
    });
    expect(JSON.stringify(out.result)).toContain('"m1"');
  });
});

describe('job conflicts', () => {
  test('JOB_CONFLICT runs the job once more; a second conflict is returned as the error', async () => {
    const f = await fixtureProject();
    const conflict = new VoxError('JOB_CONFLICT', 'the project changed', 'run again');
    const runJob = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ ok: true });
    await invokeTool(toolContext(f, { runJob }), r, 'shots', { mediaId: f.mediaId });
    expect(runJob).toHaveBeenCalledTimes(2);
    const always = vi.fn().mockRejectedValue(conflict);
    await expect(
      invokeTool(toolContext(f, { runJob: always }), r, 'shots', { mediaId: f.mediaId }),
    ).rejects.toMatchObject({
      code: 'JOB_CONFLICT',
    });
    expect(always).toHaveBeenCalledTimes(2);
  });
});

function qaResult(pass: boolean, png: string) {
  const listen = [1200, 4300, 7100, 9800, 15020].map((atMs, i) => ({
    atMs,
    timecode: `00:${String(Math.floor(atMs / 1000)).padStart(2, '0')}.${String(atMs % 1000).padStart(3, '0')}`,
    kind: i < 2 ? 'hero cue' : 'loud SFX',
    listenFor: 'one clean hit on the cut',
  }));
  return {
    schemaVersion: 1,
    mode: 'mix',
    pass,
    note: 'numbers only',
    fps: 30,
    targetLufs: -14,
    durationMs: 20000,
    checks: [
      {
        id: 'cueTiming',
        status: pass ? 'pass' : 'fail',
        limitMs: 33,
        maxAbsDeltaMs: pass ? 12 : 140,
        failures: pass ? [] : [{ cue: 2 }],
      },
      { id: 'oneEventPerCue', status: 'pass', failures: [] },
      { id: 'spacing', status: 'pass', failures: [] },
      { id: 'underSpeech', status: 'pass', failures: [] },
      { id: 'loudness', status: 'pass', integratedLufs: -14.2, truePeakDbtp: -1.4 },
    ],
    cues: [
      { index: 1, atMs: 1200, type: 'hero', hero: true },
      { index: 2, atMs: 4300, type: 'cut', hero: false },
    ],
    onsets: [{ ms: 1210, peakDbfs: -6, cue: 1 }],
    listen,
    outDir: '/x/renders/qa/seq',
    png,
  };
}

function qaPng(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vox-agent-qa-'));
  const path = join(dir, 'qa.png');
  writeFileSync(
    path,
    rgbPng(40, 30, (x, y) => [Math.floor(noise(x, y) * 200), 60, 60]),
  );
  return path;
}

describe('check_audio (step 12b, D-14)', () => {
  test('numbers, cues, five listen timecodes; qa.png goes to vision, wrapped as data', async () => {
    const f = await fixtureProject();
    const png = qaPng();
    const runJob = vi.fn(() => Promise.resolve(qaResult(true, png)));
    const describe = vi.fn(() => Promise.resolve('Marker 1: a tick in sfx and mix rows.'));
    const ctx = toolContext(f, { runJob, vision: { describe } });
    const out = await invokeTool(ctx, r, 'check_audio', { sequenceId: f.sequenceId });
    expect(runJob).toHaveBeenCalledWith('audioQa', {
      projectId: f.projectId,
      sequenceId: f.sequenceId,
    });
    const res = out.result as {
      pass: boolean;
      targetLufs: number;
      checks: { id: string; status: string }[];
      listen: { timecode: string; listenFor: string }[];
      dropped: unknown[];
      picture: string;
    };
    expect(res).toMatchObject({ pass: true, targetLufs: -14 });
    expect(res.checks.map((c) => c.id)).toEqual([
      'cueTiming',
      'oneEventPerCue',
      'spacing',
      'underSpeech',
      'loudness',
    ]);
    expect(res.listen.map((l) => l.timecode)).toEqual([
      '00:01.200',
      '00:04.300',
      '00:07.100',
      '00:09.800',
      '00:15.020',
    ]);
    expect(res.dropped).toEqual([]);
    expect(res.picture).toMatch(/^<data source="vision">\nMarker 1/);
    expect(describe).toHaveBeenCalledWith(
      [expect.objectContaining({ label: 'qa.png' })],
      expect.stringContaining('do not judge how it sounds'),
      undefined,
    );
    expect(out.images).toBeUndefined();
  });

  test('an editor with vision gets qa.png as an image', async () => {
    const f = await fixtureProject();
    const png = qaPng();
    const ctx = toolContext(f, {
      runJob: () => Promise.resolve(qaResult(true, png)),
      editorVision: true,
    });
    const out = await invokeTool(ctx, r, 'check_audio', { sequenceId: f.sequenceId });
    expect(out.images?.[0]?.label).toBe('qa.png');
  });

  test('no vision: a text fallback; a FAIL comes back as data, not a throw', async () => {
    const f = await fixtureProject();
    const png = qaPng();
    const ctx = toolContext(f, { runJob: () => Promise.resolve(qaResult(false, png)) });
    const out = await invokeTool(ctx, r, 'check_audio', { sequenceId: f.sequenceId });
    const res = out.result as {
      pass: boolean;
      checks: { status: string; maxAbsDeltaMs?: number }[];
      picture: string;
    };
    expect(res.pass).toBe(false);
    expect(res.checks[0]).toMatchObject({ status: 'fail', maxAbsDeltaMs: 140 });
    expect(res.picture).toContain('no vision model');
  });

  test('a question turn may run it (read kind)', async () => {
    const f = await fixtureProject();
    const png = qaPng();
    const ctx = toolContext(f, {
      question: true,
      runJob: () => Promise.resolve(qaResult(true, png)),
    });
    await expect(
      invokeTool(ctx, r, 'check_audio', { sequenceId: f.sequenceId }),
    ).resolves.toBeDefined();
  });
});
