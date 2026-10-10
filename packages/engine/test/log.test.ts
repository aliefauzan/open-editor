import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EngineLog } from '../src/log.ts';

describe('engine log (D-16)', () => {
  test('appends timestamped lines to logs/engine.log', async () => {
    const d = mkdtempSync(join(tmpdir(), 'vox-log-'));
    const log = new EngineLog(d, { now: () => new Date('2026-10-11T00:00:00.000Z') });
    await log.write('recovered version 4');
    expect(readFileSync(join(d, 'logs', 'engine.log'), 'utf8')).toBe(
      '2026-10-11T00:00:00.000Z recovered version 4\n',
    );
  });
  test('rotates at 5 MB keeping engine.log, .1 and .2; no line lost or split', async () => {
    const d = mkdtempSync(join(tmpdir(), 'vox-log-'));
    const log = new EngineLog(d);
    const line = (i: number) => `line ${String(i).padStart(7, '0')} ${'x'.repeat(1000)}`;
    const n = 11_000; // ~11 MB: past 5 MB twice
    for (let i = 0; i < n; i++) await log.write(line(i));
    const files = readdirSync(join(d, 'logs')).sort();
    expect(files).toEqual(['engine.log', 'engine.log.1', 'engine.log.2']);
    for (const f of files)
      expect(statSync(join(d, 'logs', f)).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    const all = ['engine.log.2', 'engine.log.1', 'engine.log'].flatMap((f) =>
      readFileSync(join(d, 'logs', f), 'utf8')
        .split('\n')
        .filter(Boolean),
    );
    const ids = all.map((l) => Number(/line (\d+) /.exec(l)?.[1]));
    // every line whole; the kept lines are the newest, contiguous, ending with the last
    for (const l of all) expect(l).toMatch(/^\S+ line \d{7} x{1000}$/);
    expect(ids.at(-1)).toBe(n - 1);
    for (let k = 1; k < ids.length; k++) expect(ids[k]).toBe(ids[k - 1]! + 1);
  });
  test('passes lines through the redactor when one is set (04)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'vox-log-'));
    const log = new EngineLog(d, { redact: (s) => s.replaceAll('sk-secret', '[redacted]') });
    await log.write('key sk-secret used');
    expect(readFileSync(join(d, 'logs', 'engine.log'), 'utf8')).toContain('key [redacted] used');
  });
});
