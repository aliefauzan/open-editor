// `<tools>/bin` links: concurrent setup checks in one engine host (launch check + a status call) must
// not collide on the temp link (a clean install hit EEXIST under load, phase 10b).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkToolBins } from '../../src/engine-host/setup/bins.ts';
import type { Manifest } from '../../src/engine-host/setup/manifest.ts';

describe('linkToolBins', () => {
  it('concurrent runs link every ready tool once and leave no temp links', async () => {
    const tools = mkdtempSync(join(tmpdir(), 'vox-bins-'));
    mkdirSync(join(tools, 'deno'), { recursive: true });
    writeFileSync(join(tools, 'deno', 'deno'), '#!/bin/sh\n');
    chmodSync(join(tools, 'deno', 'deno'), 0o755);
    const manifest = { components: [{ id: 'deno', kind: 'binary' }] } as unknown as Manifest;
    const runs = await Promise.all(Array.from({ length: 8 }, () => linkToolBins(tools, manifest)));
    expect(runs.every((r) => r['deno'] === join(tools, 'deno', 'deno'))).toBe(true);
    expect(readdirSync(join(tools, 'bin'))).toEqual(['deno']);
    expect(readlinkSync(join(tools, 'bin', 'deno'))).toBe(join('..', 'deno', 'deno'));
  });
});
