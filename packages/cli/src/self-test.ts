// `vox self-test --json` (app spec "Packaging and sharing", plan phase 09 + D-12): checks that the
// files a build ships with are there and work. From the packaged app's CLI it checks every R1
// "Packaged app" resource; checks of modules built in later phases report `skipped: <reason>` (or
// `notBuilt` for the Apple helper, D-16) until their phase lands, never `passed`.
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngine, SILERO_SHA256, type Engine, type OpCall } from '@vox/engine';

export type SelfTestStatus = 'passed' | 'failed' | 'skipped' | 'notBuilt';

export interface SelfTestCheck {
  name: string;
  status: SelfTestStatus;
  detail: string;
}

export interface SelfTestReport {
  ok: boolean;
  packaged: boolean;
  checks: SelfTestCheck[];
}

export interface SelfTestOptions {
  /** The app's Resources folder when run from the packaged app; absent from the repo. */
  resources?: string;
  /** Style folders, built-in first. */
  stylesDirs: string[];
  /** The uv project (`py/`). */
  pyDir: string;
}

/** R1 "Packaged app" rows of modules that are built now: path under Resources → what it is. */
export const PACKAGED_FILES: readonly (readonly [string, string])[] = [
  ['styles/base/style.json', 'built-in base style'],
  ['engine-data/places.json', 'places index (geo.search, map-route)'],
  ['engine-data/runtime/vox-runtime.js', 'vox runtime (compile vendors it)'],
  ['engine-data/runtime/vox-preview.js', 'vox preview runtime'],
  ['hyperframes/node_modules/hyperframes/package.json', 'pinned HyperFrames CLI'],
  ['hyperframes/node_modules/hyperframes/dist/hyperframe.runtime.iife.js', 'HyperFrames runtime'],
  ['hyperframes/node_modules/gsap/dist/gsap.min.js', 'pinned GSAP'],
  ['py/pyproject.toml', 'uv project'],
  ['py/uv.lock', 'uv lockfile'],
  ['bin/uv', 'bundled uv'],
  ['cli/vox.mjs', 'vox CLI'],
  ['cli/vox', 'vox launcher'],
];

const EXECUTABLES = new Set(['bin/uv', 'cli/vox']);

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resourcesCheck(resources: string | undefined): SelfTestCheck {
  if (resources === undefined)
    return { name: 'resources', status: 'skipped', detail: 'not a packaged build (repo layout)' };
  const missing = PACKAGED_FILES.filter(([rel]) => {
    const p = join(resources, rel);
    return EXECUTABLES.has(rel) ? !isExecutable(p) : !existsSync(p);
  }).map(([rel, what]) => `${rel} (${what})`);
  return missing.length === 0
    ? { name: 'resources', status: 'passed', detail: `${PACKAGED_FILES.length} bundled resources` }
    : { name: 'resources', status: 'failed', detail: `missing: ${missing.join(', ')}` };
}

async function attempt(
  name: string,
  fn: () => Promise<SelfTestCheck | string>,
): Promise<SelfTestCheck> {
  try {
    const r = await fn();
    return typeof r === 'string' ? { name, status: 'passed', detail: r } : r;
  } catch (e) {
    return { name, status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Compiles a one-scene project with the base style and checks the vendored files landed. */
async function compileCheck(engine: Engine): Promise<string> {
  const { id } = await engine.createProject('self-test');
  const seqId = 'seq_selftest';
  const apply = async (op: string, args: Record<string, unknown>) => {
    const r = await engine.applyOp(id, { op, args } as unknown as OpCall, { actor: 'cli' });
    if (!r.results.every((x) => x.status === 'succeeded'))
      throw new Error(`${op} failed: ${JSON.stringify(r.results)}`);
  };
  await apply('addSequence', { name: 'Self-test', id: seqId, styleId: 'base' });
  const seq = (await engine.getProject(id)).sequences.find((s) => s.id === seqId);
  const track = seq?.videoTracks[0];
  if (track === undefined) throw new Error('the new sequence has no video track');
  await apply('addScene', {
    sequenceId: seqId,
    trackId: track.id,
    startMs: 0,
    durationMs: 1000,
    template: 'base/title',
    variables: { title: 'Self-test' },
  });
  const vendored = new Set<string>();
  for (const mode of ['render', 'preview'] as const) {
    const build = await engine.compile(id, seqId, { mode });
    const dir = await engine.writeBuild(build);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const bad = build.vendor.filter((v) => {
      const p = join(dir, 'vendor', v);
      return !existsSync(p) || statSync(p).size === 0 || !html.includes(`vendor/${v}`);
    });
    if (build.vendor.length === 0 || bad.length > 0)
      throw new Error(`${mode} build: vendored files missing or not loaded: ${bad.join(', ')}`);
    build.vendor.forEach((v) => vendored.add(v));
  }
  return `base/title compiles (render + preview); vendored ${[...vendored].join(', ')}`;
}

export async function selfTest(o: SelfTestOptions): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [resourcesCheck(o.resources)];
  const tmp = mkdtempSync(join(tmpdir(), 'vox-self-test-'));
  try {
    const engine = openEngine({
      projectsDir: join(tmp, 'projects'),
      stylesDirs: o.stylesDirs,
      trustFile: join(tmp, 'trust.json'),
    });
    let styleIds: string[] = [];
    checks.push(
      await attempt('styles', async () => {
        styleIds = (await engine.styles.list()).map((s) => s.id);
        if (!styleIds.includes('base'))
          throw new Error(`base style not listed (${styleIds.join(', ')})`);
        return `styles: ${styleIds.join(', ')}`;
      }),
    );
    checks.push(
      await attempt('geo', async () => {
        const place = engine.geo.search('lisbon')[0];
        if (place === undefined) throw new Error("geo.search('lisbon') found nothing");
        return `geo.search('lisbon') → ${place.name} (${place.lat}, ${place.lon})`;
      }),
    );
    checks.push(await attempt('compile', () => compileCheck(engine)));
    checks.push(
      await attempt('silero-vad', async () => {
        const model = join(o.pyDir, 'vox_py', 'models', 'silero_vad.onnx');
        if (!existsSync(model)) throw new Error(`missing ${model}`);
        const got = sha256(model);
        if (got !== SILERO_SHA256) throw new Error(`SHA-256 ${got} does not match the R5 pin`);
        return 'vendored silero_vad.onnx matches the R5 SHA-256';
      }),
    );
    // Modules of later phases (D-12): skipped until they are in the build.
    checks.push(
      styleIds.includes('vox')
        ? await attempt('vox-style', async () => 'vox style present')
        : { name: 'vox-style', status: 'skipped', detail: 'vox style v1 arrives in phase 07' },
      { name: 'vox-map-route', status: 'skipped', detail: 'vox/map-route arrives in phase 07' },
      agentCheck(o.resources),
      { name: 'agent-workflows', status: 'skipped', detail: 'workflow prompts arrive in phase 12' },
      {
        name: 'apple-helper',
        status: 'notBuilt',
        detail: 'vox-apple-llm is bundled from phase 13',
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return {
    ok: checks.every((c) => c.status !== 'failed'),
    packaged: o.resources !== undefined,
    checks,
  };
}

function agentCheck(resources: string | undefined): SelfTestCheck {
  const prices = resources === undefined ? undefined : join(resources, 'agent', 'prices.json');
  if (prices === undefined || !existsSync(prices))
    return {
      name: 'agent-prices',
      status: 'skipped',
      detail: 'agent/prices.json arrives in phase 11',
    };
  try {
    JSON.parse(readFileSync(prices, 'utf8'));
    return { name: 'agent-prices', status: 'passed', detail: 'agent/prices.json loads' };
  } catch (e) {
    return { name: 'agent-prices', status: 'failed', detail: `agent/prices.json: ${String(e)}` };
  }
}
