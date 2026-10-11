// Op → visible preview update on the 90 s spike fixture (phase 10a; app spec "Preview pipeline":
// target < 1 s; R7 "Measurements"). The built app opens the fixture project; the bench applies ops
// through window.vox and times each until the player shows it:
// - patch: `updateScene` on a title (scene-only) → the player confirms the `vox-patch` delivery;
// - reload: `trimItem` on a V1 clip (structural) → the new build is ready and back at the playhead.
// Usage: node bench/latency.ts [--runs 10] [--evidence-dir <dir>]
// Needs the generated fixtures (packages/engine/test/fixtures/make.sh, or VOX_FIXTURES).
// Prints the JSON report, then a one-line summary. Exit 0 = pass, 2 = fail, 1 = error.
// Run under the bench lock: lockf -t 1800 <repo>/.git/vox-bench.lock pnpm -C apps/desktop bench:latency
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { makeMainSequence } from '../../../spike/lib/model.ts';
import {
  PHONE_SRC,
  SPIKE_SRC,
  engineProject,
  spikeProjectDir,
} from '../../../packages/engine/test/compile/spike90-project.ts';
import { launchApp, tempHome } from '../test/helpers/app.ts';

const BAR_MS = 1000;
const PROJECT_ID = 'p_latency90';

interface Sample {
  kind: 'patch' | 'reload';
  ms: number;
  version: number;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1) ?? NaN, min: s[0] ?? NaN };
}

/** The fixture folder with hard links (the media path rule refuses symlinks out of the project). */
function makeProject(projectsDir: string): void {
  const dir = join(projectsDir, PROJECT_ID);
  spikeProjectDir(dir);
  for (const sub of ['media', 'cfr']) {
    for (const f of readdirSync(join(dir, sub))) {
      const p = join(dir, sub, f);
      if (!lstatSync(p).isSymbolicLink()) continue;
      const target = resolve(join(dir, sub), readlinkSync(p));
      unlinkSync(p);
      linkSync(target, p);
    }
  }
  const project = engineProject(makeMainSequence());
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ ...project, id: PROJECT_ID, name: 'Latency 90 s' }, null, 2),
  );
  writeFileSync(join(dir, 'history.jsonl'), '');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { runs: { type: 'string', default: '10' }, 'evidence-dir': { type: 'string' } },
  });
  const runs = Number(values.runs);
  if (!existsSync(SPIKE_SRC) || !existsSync(PHONE_SRC)) {
    process.stderr.write(
      `[bench:latency] fixtures missing (${SPIKE_SRC}); run make.sh or set VOX_FIXTURES\n`,
    );
    return 1;
  }
  const t = tempHome('vox-latency-');
  mkdirSync(t.projectsDir, { recursive: true });
  makeProject(t.projectsDir);
  const loadStart = loadavg();
  const { app, page, consoleErrors } = await launchApp(t);
  try {
    await page.getByRole('button', { name: 'Latency 90 s' }).click();
    await page.getByTestId('player').waitFor({ timeout: 120_000 });
    await page.waitForFunction(
      () =>
        ((document.querySelector('hyperframes-player') as unknown as { duration?: number } | null)
          ?.duration ?? 0) > 0,
      undefined,
      { timeout: 120_000 },
    );
    await page.waitForTimeout(2000); // let the first mount settle
    await page.evaluate(() => {
      const w = window as unknown as { __applied: { version: number; kind: string; at: number }[] };
      w.__applied = [];
      window.addEventListener('vox-preview-applied', (e) => {
        const d = (e as CustomEvent<{ version: number; kind: string }>).detail;
        w.__applied.push({ ...d, at: performance.now() });
      });
    });
    const opened = (await page.evaluate(
      (id) => window.vox.projects.open(id),
      PROJECT_ID,
    )) as unknown as {
      project: {
        sequences: {
          id: string;
          videoTracks: {
            items: {
              id: string;
              type: string;
              template?: string;
              startMs: number;
              durationMs: number;
            }[];
          }[];
        }[];
      };
    };
    const s = opened.project.sequences[0]!;
    const title = s.videoTracks
      .flatMap((tr) => tr.items)
      .find((i) => i.type === 'scene' && i.template === 'base/title')!;
    const clip = s.videoTracks[0]!.items.find((i) => i.type === 'media' && i.durationMs > 1000)!;
    /** The player's document (opaque origin; Playwright reaches it, the app does not). */
    const playerFrame = () => page.frames().find((f) => f.url().startsWith('vox-media://'));
    const now = () => page.evaluate(() => performance.now());
    const poll = async (cond: () => Promise<boolean>, ms: number) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await cond().catch(() => false)) return true;
        await new Promise((r) => setTimeout(r, 5));
      }
      return false;
    };
    const samples: Sample[] = [];
    for (let i = 0; i < runs * 2; i++) {
      const kind = i % 2 === 0 ? 'patch' : 'reload';
      const text = `Latency run ${i}`;
      const durMs = clip.durationMs - (i % 4 === 1 ? 100 : 0);
      const started = await page.evaluate(
        async ({ projectId, kind, seqId, titleId, clipId, startMs, durMs, text }) => {
          const { version } = (await window.vox.projects.open(projectId)) as unknown as {
            version: number;
          };
          const t0 = performance.now();
          const r = await window.vox.ops.apply({
            projectId,
            op: kind === 'patch' ? 'updateScene' : 'trimItem',
            args:
              kind === 'patch'
                ? { sequenceId: seqId, itemId: titleId, variables: { title: text } }
                : { sequenceId: seqId, itemId: clipId, edge: 'end', toMs: startMs + durMs },
            baseVersion: version,
          });
          const bad = r.results.find((x) => x.status !== 'succeeded');
          return { t0, version: r.version, error: bad ? JSON.stringify(bad.error) : null };
        },
        {
          projectId: PROJECT_ID,
          kind,
          seqId: s.id,
          titleId: title.id,
          clipId: clip.id,
          startMs: clip.startMs,
          durMs,
          text,
        },
      );
      if (started.error) throw new Error(`${kind} op failed: ${started.error}`);
      const acked = () =>
        page.evaluate(
          (v) =>
            (window as unknown as { __applied: { version: number }[] }).__applied.some(
              (a) => a.version >= v,
            ),
          started.version,
        );
      // visible = the player's document has the change: the patched text, or the new build with the
      // trimmed clip's duration (and the player confirmed the delivery / is ready)
      const inDoc = async () => {
        const f = playerFrame();
        if (!f) return false;
        if (kind === 'patch')
          return f.evaluate((t) => (document.body.textContent ?? '').includes(t), text);
        return f.evaluate(
          ({ id, sec }) => {
            const el =
              document.getElementById(id) ?? document.querySelector(`[data-item-id="${id}"]`);
            const d = el?.getAttribute('data-duration');
            return d !== null && d !== undefined && Math.abs(Number(d) - sec) < 0.002;
          },
          { id: clip.id, sec: durMs / 1000 },
        );
      };
      const ok = await poll(async () => (await acked()) && (await inDoc()), 10_000);
      const end = await now();
      samples.push({
        kind,
        ms: ok ? Math.round(end - started.t0) : Infinity,
        version: started.version,
      });
      await new Promise((r) => setTimeout(r, 300));
    }
    const visible = samples.every((x) => Number.isFinite(x.ms));
    const patch = stats(samples.filter((x) => x.kind === 'patch').map((x) => x.ms));
    const reload = stats(samples.filter((x) => x.kind === 'reload').map((x) => x.ms));
    const pass = patch.max < BAR_MS && reload.max < BAR_MS && visible;
    const report = {
      bench: 'op → visible preview update, 90 s spike fixture',
      date: new Date().toISOString(),
      barMs: BAR_MS,
      pass,
      patch,
      reload,
      everyUpdateInPlayerDocument: visible,
      samples: samples as Sample[],
      machine: { cpu: cpus()[0]?.model, cores: cpus().length, loadStart, loadEnd: loadavg() },
      consoleErrors,
    };
    const json = JSON.stringify(report, null, 2);
    process.stdout.write(`${json}\n`);
    if (values['evidence-dir']) {
      mkdirSync(values['evidence-dir'], { recursive: true });
      writeFileSync(join(values['evidence-dir'], 'latency.json'), json);
    }
    process.stdout.write(
      `bench:latency ${pass ? 'PASS' : 'FAIL'} patch p50 ${patch.p50} / max ${patch.max} ms, reload p50 ${reload.p50} / max ${reload.max} ms (bar ${BAR_MS} ms)\n`,
    );
    return pass ? 0 : 2;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(
      `[bench:latency] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  },
);
