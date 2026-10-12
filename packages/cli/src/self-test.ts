// `vox self-test --json` (app spec "Packaging and sharing", plan phases 09 and 13, D-12, D-16): checks
// that the files a build ships with are there and work. From the packaged app's CLI it checks every
// R1 "Packaged app" resource. Since phase 13 every module is in the build and every check is
// required: a `skipped` result fails the self-test. The one allowed non-pass is the Apple helper's
// `notBuilt` in a `pnpm dist:no-apple` build (`build-info.json` `appleHelper: false`).
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
import { appleStatus, buildRegistry, loadWorkflow, workflowsDir } from '@vox/agent';
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
  /** Repo runs: the dev build of the Apple helper (`native/apple-llm`), if any. */
  appleHelper?: string;
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
  ['agent/workflows/clipper.md', 'clipper workflow prompt'],
  ['agent/workflows/stylize.md', 'Stylize workflow prompt'],
  ['agent/workflows/edit.md', 'free-form edit prompt'],
  ['build-info.json', 'what this build bundles (appleHelper)'],
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
  // from the repo the "resources" are the checkout itself, which the other checks use
  if (resources === undefined)
    return {
      name: 'resources',
      status: 'passed',
      detail: 'repo layout: resources from the checkout',
    };
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
    // Every module is in the build now (phase 13, D-12): each check is required.
    checks.push(
      await attempt('vox-style', async () => {
        if (!styleIds.includes('vox')) throw new Error('the vox style is not listed');
        return 'vox style present';
      }),
      await attempt('vox-map-route', () => mapRouteCheck(engine)),
      await attempt('agent-workflows', async () => {
        const names = ['clipper', 'stylize', 'edit', 'screenplay'] as const;
        for (const n of names) {
          const w = loadWorkflow(n);
          if (w.allowedTools.length === 0 && n !== 'edit') throw new Error(`${n}: no tools`);
        }
        return `workflow prompts load: ${names.join(', ')}${workflowsDir() ? ` (${workflowsDir()})` : ''}`;
      }),
      await attempt('agent-tools', async () => {
        const registry = buildRegistry({
          imageProviders: { list: () => [], register: () => undefined },
        });
        const names = registry.names();
        for (const n of names) registry.modelSchema(n);
        return `${names.length} agent tools, each with a model schema`;
      }),
      await appleHelperCheck(o),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return {
    // `skipped` fails (D-12); `notBuilt` is the one allowed non-pass (a no-apple build, D-16)
    ok: checks.every((c) => c.status === 'passed' || c.status === 'notBuilt'),
    packaged: o.resources !== undefined,
    checks,
  };
}

/** A vox sequence with a two-place `vox/map-route` scene compiles, places from the bundled data. */
async function mapRouteCheck(engine: Engine): Promise<string> {
  const a = engine.geo.search('lisbon')[0];
  const b = engine.geo.search('porto')[0];
  if (!a || !b) throw new Error('geo.search found no Lisbon or Porto');
  const { id } = await engine.createProject('self-test-map');
  const seqId = 'seq_selftestmap';
  const apply = async (op: string, args: Record<string, unknown>) => {
    const r = await engine.applyOp(id, { op, args } as unknown as OpCall, { actor: 'cli' });
    if (!r.results.every((x) => x.status === 'succeeded'))
      throw new Error(`${op} failed: ${JSON.stringify(r.results)}`);
  };
  await apply('addSequence', { name: 'Map', id: seqId, styleId: 'vox' });
  const track = (await engine.getProject(id)).sequences.find((s) => s.id === seqId)?.videoTracks[0];
  if (track === undefined) throw new Error('the new sequence has no video track');
  const place = (p: { name: string; lat: number; lon: number }) => ({
    name: p.name.slice(0, 20),
    lat: p.lat,
    lon: p.lon,
  });
  await apply('addScene', {
    sequenceId: seqId,
    trackId: track.id,
    startMs: 0,
    durationMs: 3500,
    template: 'vox/map-route',
    variables: { places: [place(a), place(b)], route: true },
  });
  const build = await engine.compile(id, seqId, { mode: 'render' });
  const dir = await engine.writeBuild(build);
  if (!existsSync(join(dir, 'index.html'))) throw new Error('map-route build wrote no index.html');
  return `vox/map-route compiles: ${a.name} → ${b.name}`;
}

/**
 * `vox-apple-llm --status` (D-16): any status passes; a missing or crashing helper fails when the
 * build says it has one. A `pnpm dist:no-apple` build (`appleHelper: false`) reports `notBuilt`.
 */
async function appleHelperCheck(o: SelfTestOptions): Promise<SelfTestCheck> {
  const name = 'apple-helper';
  let expected: boolean;
  let bin: string;
  if (o.resources !== undefined) {
    let info: { appleHelper?: unknown };
    try {
      info = JSON.parse(readFileSync(join(o.resources, 'build-info.json'), 'utf8')) as typeof info;
    } catch (e) {
      return { name, status: 'failed', detail: `build-info.json: ${String(e)}` };
    }
    expected = info.appleHelper === true;
    bin = join(o.resources, 'bin', 'vox-apple-llm');
  } else {
    bin = o.appleHelper ?? '';
    expected = bin !== '' && existsSync(bin);
  }
  if (!expected) {
    return { name, status: 'notBuilt', detail: 'notBuilt: no macOS 26+ SDK' };
  }
  if (!isExecutable(bin)) return { name, status: 'failed', detail: `missing ${bin}` };
  try {
    const s = await appleStatus({ command: bin });
    return { name, status: 'passed', detail: `vox-apple-llm --status: ${s.status}` };
  } catch (e) {
    return {
      name,
      status: 'failed',
      detail: `vox-apple-llm --status: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
