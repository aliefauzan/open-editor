// R4 S8/S13: a style can be untrusted, so the `vox style validate` harness page must not let a
// template read files outside the build folder or reach the network (the app's player blocks both).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchChrome, openHarness } from '../../src/styles/validate-dom.ts';

const root = mkdtempSync(join(tmpdir(), 'vox-harness-sandbox-'));
const build = join(root, 'build');
let server: Server;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end('leak');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(root, 'secret.txt'), 'SECRET');
  mkdirSync(join(build, 'scenes'), { recursive: true });
  writeFileSync(join(build, 'inside.txt'), 'INSIDE');
  writeFileSync(join(build, 'index.html'), '<!doctype html><html></html>');
  const probe = (name: string, url: string) =>
    `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => '${name}:' + t, () => '${name}:blocked')`;
  writeFileSync(
    join(build, 'scenes', 'hostile.html'),
    `<template><div data-vox-instance="hostile"><div id="out">pending</div><script>
Promise.all([
  new Promise((ok) => {
    const x = new XMLHttpRequest();
    x.onload = () => ok('secret:' + x.responseText);
    x.onerror = () => ok('secret:blocked');
    try { x.open('GET', '../../secret.txt'); x.send(); } catch { ok('secret:blocked'); }
  }),
  ${probe('net', `http://127.0.0.1:${port}/x`)},
]).then((r) => { document.getElementById('out').textContent = r.join(' '); });
new Image().src = 'http://127.0.0.1:${port}/img';
window.open('http://127.0.0.1:${port}/popup');
</script></div></template>`,
  );
});

afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  rmSync(root, { recursive: true, force: true });
});

test('a hostile template cannot read files outside the build folder or reach the network', async () => {
  const browser = await launchChrome();
  try {
    const pg = await openHarness(browser, build, 'hostile', { width: 400, height: 300 });
    let text = 'pending';
    for (let i = 0; i < 50 && text === 'pending'; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      text = (await pg.textBoxes()).map((b) => b.text).join(' ');
    }
    await pg.close();
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('leak');
    expect(text).toContain('secret:blocked');
    expect(text).toContain('net:blocked');
    expect(hits).toBe(0);
  } finally {
    await browser.close();
  }
}, 60_000);
