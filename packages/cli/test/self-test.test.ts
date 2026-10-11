// `vox self-test --json` (plan phases 09 and 13, D-12, D-16): from the repo every check passes and none
// is skipped; with a Resources folder that lacks R1 files the `resources` check fails and names them; the
// Apple helper check follows `build-info.json` (notBuilt for a no-apple build, --status otherwise).
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
  test('repo build: every check is required and passes; none is skipped (phase 13, D-12)', async () => {
    const { code, report } = await vox(['self-test', '--json']);
    expect(code, JSON.stringify(report, null, 2)).toBe(0);
    expect(report).toMatchObject({ ok: true, packaged: false });
    for (const name of [
      'resources',
      'styles',
      'geo',
      'compile',
      'silero-vad',
      'vox-style',
      'vox-map-route',
      'agent-workflows',
      'agent-tools',
    ])
      expect(status(report, name), name).toBe('passed');
    expect(report.checks.some((c) => c.status === 'skipped')).toBe(false);
    // the dev helper exists only in a checkout where `swift build` ran
    expect(['passed', 'notBuilt']).toContain(status(report, 'apple-helper'));
    expect(report.checks.find((c) => c.name === 'geo')?.detail).toMatch(/Lisbon/);
    expect(report.checks.find((c) => c.name === 'vox-map-route')?.detail).toMatch(/Lisbon/);
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

  /** A Resources folder with every R1 file; `build-info.json` and the helper as given. */
  function resourcesWith(appleHelper: boolean, helper?: string) {
    const res = mkdtempSync(join(tmpdir(), 'vox-res-'));
    for (const [rel] of PACKAGED_FILES) {
      const p = join(res, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, rel.endsWith('.json') ? '{}' : '#!/bin/sh\n');
      chmodSync(p, 0o755);
    }
    writeFileSync(join(res, 'build-info.json'), JSON.stringify({ version: '1.0.0', appleHelper }));
    if (helper !== undefined) {
      mkdirSync(join(res, 'bin'), { recursive: true });
      writeFileSync(join(res, 'bin', 'vox-apple-llm'), helper);
      chmodSync(join(res, 'bin', 'vox-apple-llm'), 0o755);
    }
    return res;
  }

  test('packaging (D-16): a no-apple build reports notBuilt: no macOS 26+ SDK, and passes', async () => {
    const { report } = await vox(['self-test', '--json'], resourcesWith(false));
    const a = report.checks.find((c) => c.name === 'apple-helper');
    expect(a).toMatchObject({ status: 'notBuilt', detail: 'notBuilt: no macOS 26+ SDK' });
    expect(status(report, 'resources')).toBe('passed');
  }, 60_000);

  test('packaging (D-16): appleHelper true runs --status (any status passes); missing fails', async () => {
    const helper = `#!/bin/sh\n[ "$1" = "--status" ] && echo '{"status":"notEligible","contextSize":4096}'\n`;
    const ok = await vox(['self-test', '--json'], resourcesWith(true, helper));
    expect(ok.report.checks.find((c) => c.name === 'apple-helper')).toMatchObject({
      status: 'passed',
      detail: 'vox-apple-llm --status: notEligible',
    });
    const missing = await vox(['self-test', '--json'], resourcesWith(true));
    expect(status(missing.report, 'apple-helper')).toBe('failed');
    expect(missing.code).toBe(1);
    const crash = await vox(['self-test', '--json'], resourcesWith(true, '#!/bin/sh\nexit 134\n'));
    expect(status(crash.report, 'apple-helper')).toBe('failed');
  }, 60_000);
});
