/**
 * Phase 01 spike, one command (`pnpm -C spike bench:all`): builds the projects, runs every pass-bar
 * measurement under the bench lock, and prints one JSON line per item 1-9, the heavy-scene fps
 * margin, and the GATE 1 outcome. Evidence JSON goes to out/evidence (or --evidence-dir).
 *
 *   node bench/all.ts [--reuse] [--skip-fillers] [--evidence-dir DIR]
 *
 * --reuse keeps existing renders in out/renders (cuts, sync and mechanisms are re-read from them);
 * --skip-fillers skips item 8 (mlx-whisper download on first use).
 * The allow-same-origin preview run happens only when item 4 fails in the opaque sandbox.
 */
import path from 'node:path';
import { gateOutcome } from '../lib/gate.ts';
import { run } from '../lib/proc.ts';
import { SPIKE, emit, ensureBenchLock, load } from './lib.ts';

ensureBenchLock();

type Line = Record<string, unknown> & { item?: number; name?: string; pass?: boolean | null };

const passthrough = process.argv.includes('--evidence-dir')
  ? ['--evidence-dir', process.argv[process.argv.indexOf('--evidence-dir') + 1]!]
  : [];

/** Runs one bench script (already under our lock) and returns the JSON lines it printed. */
async function step(script: string, args: string[] = []): Promise<Line[]> {
  const r = await run(process.execPath, [path.join(SPIKE, script), ...args, ...passthrough], {
    cwd: SPIKE,
    env: { ...process.env, VOX_BENCH_LOCKED: '1' },
  });
  const lines = r.stdout
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Line);
  if (r.code !== 0 && lines.length === 0)
    lines.push({ name: script, pass: false, error: r.stderr.split('\n').slice(-5).join('\n') });
  return lines;
}

const find = (lines: Line[], pred: (l: Line) => boolean): Line | undefined => lines.find(pred);

async function main() {
  const loadStart = load();
  await step('make-project.ts');
  const reuse = process.argv.includes('--reuse') ? ['--reuse'] : [];
  const main = await step('bench/render.ts', ['--seq', 'main', ...reuse]);
  const mechRender = await step('bench/mechanisms.ts');
  const ntsc = await step('bench/render.ts', ['--seq', 'ntsc', ...reuse]);
  const fillers = process.argv.includes('--skip-fillers') ? [] : await step('bench/fillers.ts');
  const opaque = await step('bench/preview.ts', ['--mode', 'opaque']);
  const item4Opaque = find(opaque, (l) => l.item === 4);
  const sameOrigin =
    item4Opaque?.pass === true ? [] : await step('bench/preview.ts', ['--mode', 'same-origin']);
  const item4Same = find(sameOrigin, (l) => l.item === 4);

  const byItem = (lines: Line[], item: number) => find(lines, (l) => l.item === item);
  const m7r = find(mechRender, (l) => l.item === 7);
  const m7p = find(opaque, (l) => l.item === 7);
  const margin = find(opaque, (l) => l.name === 'fps-margin');
  const item6 = byItem(opaque, 6);
  const out: Line[] = [
    byItem(main, 1) ?? { item: 1, pass: false, error: 'not measured' },
    byItem(main, 2) ?? { item: 2, pass: false, error: 'not measured' },
    byItem(main, 3) ?? { item: 3, pass: false, error: 'not measured (reuse skips render timing)' },
    {
      ...(item4Opaque ?? { item: 4, error: 'not measured' }),
      pass: item4Opaque?.pass === true || item4Same?.pass === true,
      opaque: item4Opaque?.pass ?? null,
      sameOrigin: item4Same ? item4Same.pass : 'not run (opaque passed)',
    },
    byItem(main, 5) ?? { item: 5, pass: false, error: 'not measured (reuse skips RSS)' },
    item6 ?? { item: 6, pass: false, error: 'not measured' },
    {
      item: 7,
      name: 'mechanisms',
      pass: m7r?.pass === true && m7p?.pass === true,
      render: m7r ?? null,
      preview: m7p ?? null,
    },
    byItem(fillers, 8) ?? {
      item: 8,
      name: 'fillers',
      pass: null,
      recordedOnly: true,
      skipped: true,
    },
    byItem(ntsc, 9) ?? { item: 9, pass: false, error: 'not measured' },
    margin ?? { name: 'fps-margin', marginPct: null },
  ];
  for (const l of out) emit(l);
  const pass = (n: number) => out.find((l) => l.item === n)?.pass === true;
  const gate = gateOutcome({
    pass: {
      1: pass(1),
      2: pass(2),
      3: pass(3),
      4: pass(4),
      5: pass(5),
      6: pass(6),
      7: pass(7),
      9: pass(9),
    },
    item4: {
      opaque: item4Opaque?.pass === true,
      ...(item4Same ? { sameOrigin: item4Same.pass === true } : {}),
    },
    marginPct: typeof margin?.marginPct === 'number' ? margin.marginPct : null,
  });
  // --reuse leaves items 3 and 5 unmeasured: the outcome line is then not a GATE 1 result
  const partial = reuse.length > 0;
  emit({
    name: 'gate-1',
    ...gate,
    ...(partial ? { partial: true } : {}),
    loadStart,
    loadEnd: load(),
  });
}

await main();
