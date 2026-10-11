// `vox self-test --json` (plan phase 09 step 5, D-12): from the repo every check of a built module
// passes and later modules report `skipped`/`notBuilt`; with a Resources folder that lacks R1 files
// the `resources` check fails and names them.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { run } from '../src/main.ts';
import { PACKAGED_FILES, type SelfTestReport } from '../src/self-test.ts';

async function vox(args: string[], resources?: string) {
  let stdout = '';
  const code = await run(args, {
    stdout: (s) => (stdout += s),
    stderr: () => {},
    env: { HOME: mkdtempSync(join(tmpdir(), 'vox-home-')), PATH: '/usr/bin:/bin' },
    cwd: process.cwd(),
    ...(resources === undefined ? {} : { resources }),
  });
  return { code, report: JSON.parse(stdout) as SelfTestReport };
}

const status = (r: SelfTestReport, name: string) => r.checks.find((c) => c.name === name)?.status;

describe('vox self-test', () => {
  test('repo build: built modules pass, later modules are skipped, never passed', async () => {
    const { code, report } = await vox(['self-test', '--json']);
    expect(code, JSON.stringify(report, null, 2)).toBe(0);
    expect(report).toMatchObject({ ok: true, packaged: false });
    for (const name of ['styles', 'geo', 'compile', 'silero-vad'])
      expect(status(report, name)).toBe('passed');
    expect(status(report, 'resources')).toBe('skipped');
    for (const name of ['vox-map-route', 'agent-prices', 'agent-workflows'])
      expect(status(report, name)).toBe('skipped');
    expect(status(report, 'apple-helper')).toBe('notBuilt');
    expect(report.checks.find((c) => c.name === 'geo')?.detail).toMatch(/Lisbon/);
  }, 60_000);

  test('packaged: a missing R1 resource fails the self-test and is named', async () => {
    const res = mkdtempSync(join(tmpdir(), 'vox-res-'));
    for (const [rel] of PACKAGED_FILES) {
      if (rel === 'engine-data/places.json') continue; // the one we leave out
      const p = join(res, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, rel.endsWith('.json') ? '{}' : '#!/bin/sh\n');
      chmodSync(p, 0o755);
    }
    const { code, report } = await vox(['self-test', '--json'], res);
    expect(code).toBe(1);
    expect(report.packaged).toBe(true);
    const r = report.checks.find((c) => c.name === 'resources');
    expect(r?.status).toBe('failed');
    expect(r?.detail).toContain('engine-data/places.json');
  }, 60_000);
});
