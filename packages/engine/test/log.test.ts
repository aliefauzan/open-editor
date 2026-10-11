import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EngineLog, LOG_MAX_BYTES } from '../src/log.ts';

describe('engine log (D-16)', () => {
  test('appends timestamped lines to logs/engine.log', async () => {
    const d = mkdtempSync(join(tmpdir(), 'vox-log-'));
    const log = new EngineLog(d, { now: () => new Date('2026-10-11T00:00:00.000Z') });
    await log.write('recovered version 4');
    expect(readFileSync(join(d, 'logs', 'engine.log'), 'utf8')).toBe(
      '2026-10-11T00:00:00.000Z recovered version 4\n',
    );
  });
  test('rotates at 5 MB: a line that would pass 5 MB starts a new engine.log', async () => {
    // The default limit, at the exact boundary. Prefilling the file keeps this to two writes, so
    // the test does not depend on how fast 5 MB of appends run on a loaded machine.
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    const d = mkdtempSync(join(tmpdir(), 'vox-log-'));
    const log = new EngineLog(d, { now: () => new Date('2026-10-11T00:00:00.000Z') });
    const file = join(d, 'logs', 'engine.log');
    const bytes = Buffer.byteLength('2026-10-11T00:00:00.000Z fits\n');
    await log.write('first');
    writeFileSync(file, Buffer.alloc(LOG_MAX_BYTES - bytes, 'a'));
    await log.write('fits'); // exactly 5 MB: no rotation
    expect(readdirSync(join(d, 'logs'))).toEqual(['engine.log']);
    expect(statSync(file).size).toBe(LOG_MAX_BYTES);
    await log.write('next'); // would pass 5 MB: rotate first
    expect(readdirSync(join(d, 'logs')).sort()).toEqual(['engine.log', 'engine.log.1']);
    expect(statSync(`${file}.1`).size).toBe(LOG_MAX_BYTES);
    expect(readFileSync(`${file}.1`, 'utf8').endsWith('2026-10-11T00:00:00.000Z fits\n')).toBe(
      true,
    );
    expect(readFileSync(file, 'utf8')).toBe('2026-10-11T00:00:00.000Z next\n');
  });
  test('rotation keeps engine.log, .1 and .2; no line lost or split', async () => {
    // Same rotation code as the default, at a 64 KiB limit: the same ~2.2 limits of 1 KB lines as
    // 11 MB at 5 MB, in 1/80 of the appends, so a slow disk under load cannot run it out of time.
    const max = 64 * 1024;
    const d = mkdtempSync(join(tmpdir(), 'vox-log-'));
    const log = new EngineLog(d, { maxBytes: max });
    const line = (i: number) => `line ${String(i).padStart(7, '0')} ${'x'.repeat(1000)}`;
    const n = 140; // ~140 KB: past the limit twice
    for (let i = 0; i < n; i++) await log.write(line(i));
    const files = readdirSync(join(d, 'logs')).sort();
    expect(files).toEqual(['engine.log', 'engine.log.1', 'engine.log.2']);
    for (const f of files) expect(statSync(join(d, 'logs', f)).size).toBeLessThanOrEqual(max);
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
