// S11: invalid arguments are rejected by zod before a call reaches the engine host.
import { describe, expect, it } from 'vitest';
import { EVENTS, METHODS, METHOD_ARGS, parseCall } from '../../src/shared/api.ts';

describe('window.vox schema (app spec "Engine-host API")', () => {
  it('covers every method of the app spec table', () => {
    const table = [
      'projects.list', 'projects.create', 'projects.open', 'projects.reveal',
      'ops.apply', 'history.undo', 'history.redo', 'history.list',
      'snapshots.list', 'snapshots.create',
      'media.importFiles', 'media.importUrl', 'media.classifyUrl', 'media.search', 'media.peaks',
      'captions.get', 'jobs.start', 'jobs.get', 'jobs.cancel', 'preview.url', 'geo.search',
      'agent.run', 'agent.runs', 'agent.stop', 'agent.decide', 'agent.undoRun',
      'settings.get', 'settings.save', 'settings.probe',
      'styles.list', 'styles.get', 'styles.accept', 'styles.remove',
      'exports.chooseTarget', 'exports.lastFolder', 'exports.reveal',
      'setup.status', 'setup.install', 'setup.updateYtDlp',
    ]; // prettier-ignore
    expect([...METHODS].sort()).toEqual([...table].sort());
    expect(EVENTS).toEqual(
      expect.arrayContaining([
        'project.changed',
        'job.progress',
        'preview.updated',
        'setup.progress',
      ]),
    );
  });

  it('accepts the D-15 ops.apply shape with coalesceKey', () => {
    const r = parseCall('ops.apply', [
      {
        projectId: 'p_abc',
        op: 'updateClip',
        args: { x: 1 },
        baseVersion: 3,
        coalesceKey: 'volume:it_1',
      },
    ]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['unknown method', 'fs.readFile', []],
    ['prototype key', 'constructor', []],
    ['missing args', 'projects.open', []],
    ['bad project id', 'projects.open', ['../etc']],
    ['extra arg', 'projects.list', [1]],
    [
      'negative baseVersion',
      'ops.apply',
      [{ projectId: 'p_a', op: 'x', args: {}, baseVersion: -1 }],
    ],
    [
      'unknown key',
      'ops.apply',
      [{ projectId: 'p_a', op: 'x', args: {}, baseVersion: 0, evil: 1 }],
    ],
    ['raw path in render job', 'jobs.start', ['render', { path: '/tmp/x.mp4' }]],
    ['raw dir in job', 'jobs.start', ['render', { dir: '/tmp' }]],
    ['bad loudness', 'jobs.start', ['render', { targetId: 't1', loudness: 'loud' }]],
    ['bad sequence id', 'preview.url', ['p_a', 'seq/../x']],
    ['not an array', 'projects.list', 'nope'],
  ])('rejects %s', (_label, method, args) => {
    const r = parseCall(method, args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ARGS_INVALID');
  });

  it('accepts a render job with a targetId and loudness', () => {
    expect(
      parseCall('jobs.start', ['render', { targetId: 't1', loudness: 'tiktok', captions: 'burn' }])
        .ok,
    ).toBe(true);
  });

  it('every method has a zod tuple', () => {
    for (const m of METHODS) expect(METHOD_ARGS[m].def.type).toBe('tuple');
  });
});
