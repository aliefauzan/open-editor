// `vox style validate <styleId>` (styles spec "Template rules", "Style registry", "Testing"; phase 06).
// Checks the style's own templates (a pure re-skin with none renders its inherited ones, phase 15),
// caption presets, overlays and SFX credits:
// - static: schema (the registry load), text variables declare `maxLength`, fixtures match the
//   variables schema, hook source + imports + determinism, file references, SFX credits;
// - render: every fixture back to back in one sequence (overlays off), `hyperframes lint` on the
//   preview build (templates inlined, so lint sees them), `render --strict-all` draft, non-blank
//   frames, cue timing by per-frame pixel difference;
// - DOM (Chrome): the longest text fixture stays inside the safe area, `minEntranceMs` resting state,
//   caption preset word states, emphasis, safe area (also at `position.yPct` 95), seek, `case`;
// - previews: `previews/contact.jpg` (one cell per fixture, transition and caption preset), and per
//   template `previews/<name>.jpg` + `previews/<name>.gif`.
// The SFX kit rules join in phase 07 (`audio-qa --kit`).
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { compileSequence, presetText, type CompileOptions } from '../compile/compile.ts';
import { writeBuildTo } from '../compile/write.ts';
import { isVoxError } from '../errors.ts';
import { repoPyProject, runPyTool, type PyBridgeOptions } from '../py.ts';
import type { MediaItem, Project, Sequence, Track, Transcript } from '../model/schema.ts';
import { CAPTION_DEFAULTS } from '../ops/captions.ts';
import { hyperframesBin } from '../render/layers.ts';
import { cueTimingFindings, windowDiffs, type CueAt } from './cue-timing.ts';
import { checkHookDeterminism, checkHookSource } from './hookcheck.ts';
import type { ResolvedStyle, StyleRegistry, TemplateDef } from './registry.ts';
import { captionSafeArea, variablesValidator, type SafeArea } from './schema.ts';
import {
  FIXTURE_CHUNKS,
  launchChrome,
  openHarness,
  sameState,
  type Box,
  type HarnessPage,
} from './validate-dom.ts';

const run = promisify(execFile);

export interface ValidateProblem {
  rule: string;
  message: string;
  template?: string;
  fixture?: string;
  preset?: string;
}

export interface ValidateReport {
  styleId: string;
  ok: boolean;
  problems: ValidateProblem[];
  /** Checks that were skipped or informational lines. */
  notes: string[];
  /** Count of each check that ran. */
  checked: Record<string, number>;
  /** Files written to `previews/`. */
  previews: string[];
}

export interface ValidateOptions {
  registry: StyleRegistry;
  styleId: string;
  /** Render fixtures (lint, render, frames, cue timing, previews). Default true. */
  render?: boolean;
  /** Chrome checks (safe area, `minEntranceMs`, caption presets). Default true. */
  dom?: boolean;
  /** Write `previews/` (needs `render`). Default true. */
  previews?: boolean;
  ffmpeg?: string;
  /** SFX kit check (`audio-qa --kit`, styles spec "SFX rules"). Default true. */
  kit?: boolean;
  /** Python tool bridge for the kit check; default the repo's `py/` with `uv` from PATH. */
  py?: Pick<PyBridgeOptions, 'pyProject' | 'uv' | 'toolsDir'>;
  /** Scratch folder; default a new temp folder, removed at the end. */
  workDir?: string;
  onProgress?: (line: string) => void;
}

const W = 1080;
const H = 1920;
const FPS = { num: 30, den: 1 };
const GAP_MS = 500;
const CLIP_MS = 1500;
const CELL = { w: 270, h: 480 };
const PREVIEW_W = 540;

const frameOf = (ms: number) => Math.round((ms * FPS.num) / (FPS.den * 1000));

// ---- static checks ----

/** JSON pointers of string variables without `maxLength` (enums, consts and media slots excepted). */
export function textWithoutMaxLength(
  schema: unknown,
  slots: Record<string, string> = {},
): string[] {
  const out: string[] = [];
  const slotPaths = new Set(Object.keys(slots));
  const walk = (node: unknown, path: string[]) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;
    const types = Array.isArray(n['type']) ? n['type'] : [n['type']];
    const key = path.join('/');
    if (
      types.includes('string') &&
      n['maxLength'] === undefined &&
      n['enum'] === undefined &&
      n['const'] === undefined &&
      !slotPaths.has(key)
    ) {
      out.push(`/${key}`);
    }
    const props = n['properties'];
    if (props && typeof props === 'object') {
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) walk(v, [...path, k]);
    }
    if (n['items']) walk(n['items'], [...path, '*']);
    for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
      if (Array.isArray(n[k])) for (const v of n[k] as unknown[]) walk(v, path);
    }
  };
  walk(schema, []);
  return out;
}

/** Total characters of every string in a fixture (the "longest" fixture is the largest). */
export function textLength(v: unknown): number {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((s: number, x) => s + textLength(x), 0);
  if (v && typeof v === 'object')
    return Object.values(v).reduce((s: number, x) => s + textLength(x), 0);
  return 0;
}

const REF = /\b(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/g;

/**
 * File references in a template/preset/overlay HTML file. Templates reach files only through
 * tokens, slots and hook files, so any other relative reference is a missing asset at render time,
 * and a remote one breaks "no CDN at render time".
 */
export function fileRefProblems(html: string): { rule: string; ref: string }[] {
  const out: { rule: string; ref: string }[] = [];
  for (const m of html.matchAll(REF)) {
    const ref = (m[1] ?? m[2] ?? '').trim();
    if (
      ref === '' ||
      ref.startsWith('#') ||
      ref.startsWith('data:') ||
      ref.startsWith('blob:') ||
      ref.startsWith('var(') ||
      ref.includes('__')
    ) {
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) out.push({ rule: 'remote-asset', ref });
    else out.push({ rule: 'missing-asset', ref });
  }
  return out;
}

function loadRule(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const file = isVoxError(e) ? String(e.details?.['file'] ?? '') : '';
  if (`${file} ${msg}`.includes(`${sep}captions${sep}`) || /caption preset/.test(msg)) {
    return 'caption-preset';
  }
  if (msg.includes('skipEntrance')) return 'skip-entrance';
  return 'schema';
}

interface Fixture {
  name: string;
  vars: Record<string, unknown>;
}

function readFixtures(def: TemplateDef): Fixture[] {
  return [...def.fixtures].sort().map((f) => ({
    name: basename(f, '.json'),
    vars: JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>,
  }));
}

const inside = (dir: string, file: string) => {
  try {
    return realpathSync(file).startsWith(realpathSync(dir) + sep);
  } catch {
    return false;
  }
};

// ---- the validation project ----

function sampleMedia(): MediaItem[] {
  const video: MediaItem = {
    id: 'm_video',
    kind: 'video',
    path: 'media/m_video.mp4',
    proxyPath: 'media/m_video.mp4',
    durationMs: 8000,
    width: W,
    height: H,
    hasAudio: false,
    fps: FPS,
    origin: { type: 'generated' },
    tags: [],
  };
  const image = (id: string, file: string, width: number, height: number): MediaItem => ({
    id,
    kind: 'image',
    path: `media/${file}`,
    width,
    height,
    origin: { type: 'generated' },
    tags: [],
  });
  return [
    video,
    image('m_img', 'm_img.jpg', 1200, 1600),
    image('m_cutout', 'm_cutout.png', 800, 800),
  ];
}

async function makeSampleMedia(ffmpeg: string, projectDir: string): Promise<void> {
  const dir = join(projectDir, 'media');
  mkdirSync(dir, { recursive: true });
  const ff = (args: string[]) => run(ffmpeg, ['-v', 'error', '-y', ...args], { timeout: 120_000 });
  await ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${W}x${H}:rate=30:duration=8`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '15',
    join(dir, 'm_video.mp4'),
  ]);
  await ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1200x1600:rate=1:duration=1',
    '-frames:v',
    '1',
    join(dir, 'm_img.jpg'),
  ]);
  await ff([
    '-f',
    'lavfi',
    '-i',
    // an opaque box on a transparent canvas (drawbox would leave the alpha at 0)
    'color=c=0xe07a2f:s=400x500,format=rgba,pad=800:800:200:150:color=black@0.0',
    '-frames:v',
    '1',
    join(dir, 'm_cutout.png'),
  ]);
}

const track = (id: string, items: Track['items'] = []): Track => ({
  id,
  locked: false,
  hidden: false,
  muted: false,
  syncLock: true,
  items,
});

function project(styleId: string, seq: Partial<Sequence>, media: MediaItem[]): Project {
  const sequence: Sequence = {
    id: 'seq_validate',
    name: 'validate',
    canvas: { width: W, height: H, fps: FPS },
    styleId,
    videoTracks: [track('V1'), track('V2')],
    audioTracks: [track('A1'), track('A2')],
    captions: null,
    sfx: false,
    overlays: [],
    ...seq,
  };
  return {
    schemaVersion: 2,
    id: 'p_validate',
    name: 'validate',
    version: 0,
    media,
    sequences: [sequence],
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sourceUrls: [],
    },
  };
}

interface Window {
  kind: 'scene' | 'transition';
  def: TemplateDef;
  fixture: string;
  startMs: number;
  durationMs: number;
  /** Contact sheet / thumbnail time (ms on the sequence). */
  stillMs: number;
  /** Transitions: the cut, which their cue offsets count from (engine "Sound cues"). */
  cutMs?: number;
}

/**
 * Cue frames relative to a window's first frame: scene cues count from the scene start, transition
 * cues from the cut (phase 07: transitions are measured like scenes).
 */
export function windowCueFrames(
  w: Pick<Window, 'kind' | 'startMs' | 'cutMs'>,
  cues: readonly { name: string; type: CueAt['type']; atMs: number | 'entrance' }[],
): CueAt[] {
  const base = w.kind === 'transition' ? (w.cutMs ?? w.startMs) : w.startMs;
  return cues.map((q) => ({
    name: q.name,
    type: q.type,
    frame: frameOf(base + (q.atMs === 'entrance' ? 0 : q.atMs)) - frameOf(w.startMs),
  }));
}

const clampDur = (def: TemplateDef, ms: number) =>
  Math.min(def.durationMs.max, Math.max(def.durationMs.min, ms));

// ---- main ----

export async function validateStyle(o: ValidateOptions): Promise<ValidateReport> {
  const report: ValidateReport = {
    styleId: o.styleId,
    ok: false,
    problems: [],
    notes: [],
    checked: {},
    previews: [],
  };
  const problem = (p: ValidateProblem) => report.problems.push(p);
  const count = (rule: string, n = 1) => (report.checked[rule] = (report.checked[rule] ?? 0) + n);
  const progress = (s: string) => o.onProgress?.(s);

  let style: ResolvedStyle;
  try {
    style = o.registry.get(o.styleId);
    count('schema');
  } catch (e) {
    problem({ rule: loadRule(e), message: e instanceof Error ? e.message : String(e) });
    return report;
  }

  const own = Object.values(style.templates)
    .filter((t) => t.styleId === style.id)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const fixtures = new Map<string, Fixture[]>();
  // A pure re-skin (no own templates: a `vox style new` child or an extracted draft, styles Part C)
  // renders every inherited template's fixtures in its own tokens; the static template checks stay
  // with the declaring style. Trusted parents' hooks run through the untrusted child (S8).
  const rendered =
    own.length > 0 ? own : Object.values(style.templates).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (own.length === 0) {
    for (const def of rendered) fixtures.set(def.id, readFixtures(def));
    if (rendered.length > 0)
      report.notes.push(`re-skin: renders the ${String(rendered.length)} inherited templates`);
  }

  // static checks
  for (const def of own) {
    const fx = readFixtures(def);
    fixtures.set(def.id, fx);
    count('fixtures');
    if (fx.length === 0) {
      problem({
        rule: 'fixtures-missing',
        template: def.id,
        message: `${def.id} has no fixtures/*.json`,
      });
    }
    const validate = variablesValidator(def.variables as Record<string, unknown>);
    for (const f of fx) {
      if (!validate(f.vars)) {
        problem({
          rule: 'fixture-invalid',
          template: def.id,
          fixture: f.name,
          message: `fixture ${f.name} does not match the variables schema: ${JSON.stringify(validate.errors?.slice(0, 3))}`,
        });
      }
    }
    count('text-max-length');
    for (const ptr of textWithoutMaxLength(def.variables, def.slots)) {
      problem({
        rule: 'text-max-length',
        template: def.id,
        message: `text variable ${ptr} declares no maxLength`,
      });
    }
    count('file-refs');
    for (const r of fileRefProblems(readFileSync(def.htmlPath, 'utf8'))) {
      problem({ rule: r.rule, template: def.id, message: `template.html references ${r.ref}` });
    }
    if (def.hookPath) {
      count('hook-source');
      for (const f of checkHookSource(style.dir, def.hookPath)) {
        problem({ rule: f.rule, template: def.id, message: `${f.file}: ${f.message}` });
      }
      if (def.trusted) {
        count('hook-determinism');
        try {
          for (const f of await checkHookDeterminism(def, style.dir, fx)) {
            problem({ rule: f.rule, template: def.id, fixture: f.fixture, message: f.message });
          }
        } catch (e) {
          problem({
            rule: 'hook-determinism',
            template: def.id,
            message: `hook failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      } else {
        report.notes.push(
          `${def.id}: hook not run (style not trusted; \`vox style trust ${style.id}\`); determinism unchecked`,
        );
      }
    }
  }
  for (const p of Object.values(style.captionPresets).filter((p) => p.styleId === style.id)) {
    count('file-refs');
    for (const r of fileRefProblems(readFileSync(p.htmlPath, 'utf8'))) {
      problem({
        rule: r.rule,
        preset: p.id,
        message: `${basename(p.htmlPath)} references ${r.ref}`,
      });
    }
  }
  for (const ov of style.overlays.filter((x) => x.styleId === style.id)) {
    count('file-refs');
    for (const r of fileRefProblems(readFileSync(ov.htmlPath, 'utf8'))) {
      problem({ rule: r.rule, message: `overlay ${ov.name} references ${r.ref}` });
    }
  }
  sfxCredits(style, problem, count);
  if (o.kit !== false) {
    progress('sfx kit');
    await sfxKit(style, o, problem, count, report);
  }

  const wantRender = o.render !== false;
  const wantDom = o.dom !== false;
  if (!wantRender && !wantDom) {
    report.notes.push('render and DOM checks skipped');
    report.ok = report.problems.length === 0;
    return report;
  }

  const work = o.workDir ?? mkdtempSync(join(tmpdir(), 'vox-validate-'));
  const ffmpeg = o.ffmpeg ?? 'ffmpeg';
  const projectDir = join(work, 'p_validate');
  const media = sampleMedia();
  const input = (p: Project) => ({
    project: p,
    projectDir,
    sequenceId: 'seq_validate',
    registry: o.registry,
    transcriptOf: () => FIXTURE_TRANSCRIPT,
  });
  const compile = async (p: Project, opts: CompileOptions, dir: string) => {
    const b = await compileSequence(input(p), opts);
    return writeBuildTo(b, dir);
  };
  const cells: { file: string; label: Record<string, string> }[] = [];
  try {
    progress('sample media');
    await makeSampleMedia(ffmpeg, projectDir);

    if (wantRender) {
      await renderPass({
        o,
        style,
        own: rendered,
        fixtures,
        media,
        work,
        ffmpeg,
        compile,
        problem,
        count,
        progress,
        report,
        cells,
      });
    }
    if (wantDom) {
      await domPass({
        style,
        own: rendered,
        fixtures,
        media,
        work,
        compile,
        problem,
        count,
        progress,
        cells,
        report,
      });
    }
    if (wantRender && o.previews !== false && cells.length > 0) {
      progress('contact sheet');
      const out = join(style.dir, 'previews');
      mkdirSync(out, { recursive: true });
      await contactSheet(ffmpeg, work, cells, out);
      report.previews.push('previews/contact.jpg', 'previews/contact.json');
    }
  } catch (e) {
    problem({
      rule: 'validate-failed',
      message: e instanceof Error ? e.message.slice(0, 1500) : String(e),
    });
  } finally {
    if (!o.workDir) rmSync(work, { recursive: true, force: true });
  }
  report.ok = report.problems.length === 0;
  return report;
}

function sfxCredits(
  style: ResolvedStyle,
  problem: (p: ValidateProblem) => void,
  count: (r: string) => void,
): void {
  const ownSfx = Object.entries(style.files.sfx).filter(([, f]) => inside(style.dir, f));
  if (ownSfx.length === 0) return;
  count('sfx-credits');
  const credits = join(style.dir, 'assets', 'sfx', 'CREDITS.md');
  const text = existsSync(credits) ? readFileSync(credits, 'utf8') : '';
  for (const [name, file] of ownSfx) {
    const entry = text.split('\n').find((l) => l.includes(basename(file)));
    if (!entry) {
      problem({
        rule: 'sfx-credits',
        message: `sfx ${name}: ${basename(file)} has no entry in assets/sfx/CREDITS.md`,
      });
    } else if (!/\b(?:CC0|project)\b/.test(entry)) {
      problem({
        rule: 'sfx-credits',
        message: `sfx ${name}: the CREDITS.md entry for ${basename(file)} names no licence (CC0 or project)`,
      });
    }
  }
}

const KitResult = z.looseObject({
  mode: z.literal('kit'),
  pass: z.boolean(),
  files: z.array(
    z.looseObject({
      path: z.string(),
      pass: z.boolean(),
      checks: z.array(z.looseObject({ id: z.string(), pass: z.boolean(), rule: z.string() })),
    }),
  ),
});

/**
 * The SFX kit check (phase 07 step 8b): every own SFX file through the audio QA kit mode; a failing
 * check becomes an `sfx-kit` problem naming the file and the rule. The sheet (one waveform and
 * spectrogram per file) is copied to `previews/sfx-sheet.png` for a person or a vision review.
 */
async function sfxKit(
  style: ResolvedStyle,
  o: ValidateOptions,
  problem: (p: ValidateProblem) => void,
  count: (r: string) => void,
  report: ValidateReport,
): Promise<void> {
  const own = Object.entries(style.files.sfx)
    .filter(([, f]) => inside(style.dir, f))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (own.length === 0) return;
  count('sfx-kit');
  const out = mkdtempSync(join(tmpdir(), 'vox-kit-'));
  try {
    const r = await runPyTool(
      'audioqa',
      {
        mode: 'kit',
        styleId: style.id,
        files: own.map(([name, path]) => ({ path, type: style.style.sfx[name]?.type ?? 'cut' })),
        outDir: out,
        ...(o.ffmpeg ? { ffmpeg: o.ffmpeg } : {}),
      },
      KitResult,
      { pyProject: o.py?.pyProject ?? repoPyProject(), ...o.py },
    );
    r.files.forEach((f, i) => {
      const name = own[i]![0];
      for (const c of f.checks.filter((x) => !x.pass)) {
        problem({
          rule: 'sfx-kit',
          message: `sfx ${name}: ${basename(f.path)} fails ${c.id} (${c.rule})`,
        });
      }
    });
    if (o.previews !== false) {
      const dir = join(style.dir, 'previews');
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(out, `kit-${style.id}.png`), join(dir, 'sfx-sheet.png'));
      report.previews.push('previews/sfx-sheet.png');
    }
  } catch (e) {
    problem({
      rule: 'sfx-kit',
      message: `the SFX kit check did not run: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Words the caption projects are compiled from (the injected chunks replace them). */
const FIXTURE_TRANSCRIPT: Transcript = {
  language: 'en',
  words: [
    { text: 'One', startMs: 100, endMs: 400, kind: 'word' },
    { text: 'two', startMs: 400, endMs: 800, kind: 'word' },
    { text: 'three', startMs: 800, endMs: 1100, kind: 'word' },
  ],
  speechRegions: [{ startMs: 100, endMs: 1100 }],
};

interface PassCtx {
  style: ResolvedStyle;
  own: TemplateDef[];
  fixtures: Map<string, Fixture[]>;
  media: MediaItem[];
  work: string;
  compile: (p: Project, opts: CompileOptions, dir: string) => Promise<string>;
  problem: (p: ValidateProblem) => void;
  count: (r: string, n?: number) => void;
  progress: (s: string) => void;
  cells: { file: string; label: Record<string, string> }[];
  report: ValidateReport;
}

async function hf(args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await run(process.execPath, [hyperframesBin(), ...args], {
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { ok: true, out: `${r.stdout}${r.stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}` };
  }
}

async function renderPass(c: PassCtx & { o: ValidateOptions; ffmpeg: string }): Promise<void> {
  const { style, own, fixtures, media, work, ffmpeg, problem, count, progress } = c;
  const windows: Window[] = [];
  const scenes: Track['items'] = [];
  const v1: Track['items'] = [];
  let t = 0;
  let n = 0;
  for (const def of own.filter((d) => d.kind === 'scene')) {
    for (const f of fixtures.get(def.id) ?? []) {
      const dur = clampDur(def, def.durationMs.default);
      scenes.push({
        id: `it_s${n++}`,
        type: 'scene',
        template: def.id,
        templateVersion: def.version,
        startMs: t,
        durationMs: dur,
        variables: f.vars,
      });
      windows.push({
        kind: 'scene',
        def,
        fixture: f.name,
        startMs: t,
        durationMs: dur,
        stillMs: t + Math.round(dur * 0.6),
      });
      t += dur + GAP_MS;
    }
  }
  for (const def of own.filter((d) => d.kind === 'transition')) {
    const dur = clampDur(def, def.durationMs.default);
    const cut = t + CLIP_MS;
    v1.push(
      {
        id: `it_a${n}`,
        type: 'media',
        mediaId: 'm_video',
        startMs: t,
        durationMs: CLIP_MS,
        inMs: 1000,
      },
      {
        id: `it_b${n++}`,
        type: 'media',
        mediaId: 'm_video',
        startMs: cut,
        durationMs: CLIP_MS,
        inMs: 4000,
        transitionIn: { template: def.id, durationMs: dur },
      },
    );
    windows.push({
      kind: 'transition',
      def,
      fixture: '(cut)',
      startMs: cut - Math.round(dur / 2) - 300,
      durationMs: dur + 600,
      stillMs: cut - Math.round(dur / 4),
      cutMs: cut,
    });
    t += 2 * CLIP_MS + GAP_MS;
  }
  if (windows.length === 0) {
    c.report.notes.push('no own templates: nothing rendered');
    return;
  }
  const p = project(style.id, { videoTracks: [track('V1', v1), track('V2', scenes)] }, media);

  progress('lint (preview build)');
  const previewDir = await c.compile(p, { mode: 'preview' }, join(work, 'lint'));
  count('lint');
  const lint = await hf(['lint', previewDir, '--json'], 300_000);
  for (const f of lintErrors(lint.out)) {
    problem({
      rule: 'lint',
      message: `${f.code ?? f.rule ?? 'error'}: ${f.message ?? ''}`.slice(0, 400),
    });
  }

  progress(`render ${windows.length} fixtures (draft, --strict-all)`);
  const renderDir = await c.compile(p, { mode: 'render' }, join(work, 'render'));
  const mp4 = join(work, 'fixtures.mp4');
  count('render');
  const r = await hf(
    [
      'render',
      renderDir,
      '-o',
      mp4,
      '--quality',
      'draft',
      '--fps',
      '30',
      '--strict-all',
      '--frames-cache-dir',
      'off',
    ],
    1_800_000,
  );
  if (!r.ok || !existsSync(mp4)) {
    problem({
      rule: 'render',
      message: `hyperframes render --strict-all failed: ${r.out.slice(-1200)}`,
    });
    return;
  }

  progress('frame analysis');
  const gray = await grayFrames(ffmpeg, mp4);
  for (const w of windows) {
    count('blank-frame');
    const mid = gray[frameOf(w.stillMs)];
    if (!mid || stddev(mid) < 1.5) {
      problem({
        rule: 'blank-frame',
        template: w.def.id,
        fixture: w.fixture,
        message: `frame ${frameOf(w.stillMs)} of ${w.def.id} (${w.fixture}) is blank`,
      });
    }
    if (w.def.sfxCues?.length) {
      count('cue-timing');
      const s = frameOf(w.startMs);
      const e = frameOf(w.startMs + w.durationMs);
      const diffs = windowDiffs(gray, s, e);
      const cues = windowCueFrames(w, w.def.sfxCues);
      for (const f of cueTimingFindings(diffs, cues)) {
        problem({ rule: 'cue-timing', template: w.def.id, fixture: w.fixture, message: f.message });
      }
    }
  }

  if (c.o.previews === false) return;
  progress('previews');
  const out = join(style.dir, 'previews');
  mkdirSync(out, { recursive: true });
  const cellsDir = join(work, 'cells');
  mkdirSync(cellsDir, { recursive: true });
  const ff = (args: string[]) => run(ffmpeg, ['-v', 'error', '-y', ...args], { timeout: 300_000 });
  const firstOf = new Map<string, Window>();
  for (const w of windows) {
    const file = join(cellsDir, `r${String(c.cells.length).padStart(3, '0')}.png`);
    await ff([
      '-ss',
      sec(w.stillMs),
      '-i',
      mp4,
      '-frames:v',
      '1',
      '-vf',
      `scale=${CELL.w}:${CELL.h}`,
      file,
    ]);
    c.cells.push({ file, label: { kind: w.kind, template: w.def.id, fixture: w.fixture } });
    if (!firstOf.has(w.def.id)) firstOf.set(w.def.id, w);
  }
  for (const [, w] of firstOf) {
    const name = w.def.name;
    await ff([
      '-ss',
      sec(w.stillMs),
      '-i',
      mp4,
      '-frames:v',
      '1',
      '-vf',
      `scale=${PREVIEW_W}:-2`,
      '-q:v',
      '3',
      join(out, `${name}.jpg`),
    ]);
    await ff([
      '-ss',
      sec(w.startMs),
      '-t',
      sec(w.durationMs),
      '-i',
      mp4,
      '-vf',
      `fps=10,scale=${CELL.w}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse`,
      '-loop',
      '0',
      join(out, `${name}.gif`),
    ]);
    c.report.previews.push(`previews/${name}.jpg`, `previews/${name}.gif`);
  }
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

function stddev(px: Uint8Array): number {
  let s = 0;
  for (const v of px) s += v;
  const mean = s / px.length;
  let q = 0;
  for (const v of px) q += (v - mean) ** 2;
  return Math.sqrt(q / px.length);
}

async function grayFrames(ffmpeg: string, mp4: string): Promise<Uint8Array[]> {
  const w = 108;
  const h = 192;
  const r = await run(
    ffmpeg,
    ['-v', 'error', '-i', mp4, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 30, timeout: 600_000 },
  );
  const buf = r.stdout as unknown as Buffer;
  const size = w * h;
  const out: Uint8Array[] = [];
  for (let i = 0; i + size <= buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

interface LintFinding {
  severity?: string;
  level?: string;
  code?: string;
  rule?: string;
  message?: string;
}

function lintErrors(out: string): LintFinding[] {
  const start = out.indexOf('{');
  if (start < 0) return [{ message: `hyperframes lint gave no JSON: ${out.slice(0, 300)}` }];
  try {
    const parsed = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)) as Record<
      string,
      unknown
    >;
    const list = (parsed['findings'] ??
      parsed['issues'] ??
      parsed['results'] ??
      []) as LintFinding[];
    return list.filter((f) => (f.severity ?? f.level) === 'error');
  } catch {
    return [{ message: `hyperframes lint output is not JSON: ${out.slice(0, 300)}` }];
  }
}

function outsideBox(b: Box, safe: SafeArea): string | undefined {
  const sx = (W * safe.rightPct) / 100;
  const maxY = H * (1 - safe.bottomPct / 100);
  const tol = 0.5;
  if (b.left < sx - tol) return `left ${b.left.toFixed(0)} < ${sx.toFixed(0)}`;
  if (b.right > W - sx + tol) return `right ${b.right.toFixed(0)} > ${(W - sx).toFixed(0)}`;
  if (b.top < -tol) return `top ${b.top.toFixed(0)} < 0`;
  if (b.bottom > maxY + tol) return `bottom ${b.bottom.toFixed(0)} > ${maxY.toFixed(0)}`;
  return undefined;
}

async function domPass(c: PassCtx): Promise<void> {
  const { style, own, fixtures, media, work, problem, count, progress } = c;
  const defaultPreset =
    style.captionPresets[style.style.captions.default] ?? Object.values(style.captionPresets)[0];
  const safe: SafeArea = defaultPreset
    ? captionSafeArea(defaultPreset, { width: W, height: H })
    : { bottomPct: 20, rightPct: 12 };
  const jitter = (style.style.tokens.motion.jitterPx ?? 0) + 0.5;

  // scene items: the longest text fixture of each scene template; minEntranceMs short and long runs
  const items: Track['items'] = [];
  const plan: {
    kind: 'safe' | 'short' | 'long';
    def: TemplateDef;
    id: string;
    dur: number;
    fixture: string;
  }[] = [];
  let t = 0;
  let n = 0;
  const place = (kind: 'safe' | 'short' | 'long', def: TemplateDef, f: Fixture, dur: number) => {
    const id = `it_d${n++}`;
    items.push({
      id,
      type: 'scene',
      template: def.id,
      templateVersion: def.version,
      startMs: t,
      durationMs: dur,
      variables: f.vars,
    });
    plan.push({ kind, def, id, dur, fixture: f.name });
    t += dur;
  };
  for (const def of own.filter((d) => d.kind === 'scene')) {
    const fx = fixtures.get(def.id) ?? [];
    if (fx.length === 0) continue;
    const longest = fx.reduce((a, b) => (textLength(b.vars) > textLength(a.vars) ? b : a));
    place('safe', def, longest, clampDur(def, def.durationMs.default));
    const m = def.minEntranceMs;
    if (m !== undefined) {
      const short = Math.max(def.durationMs.min, Math.floor(m * 0.75));
      const long = clampDur(def, Math.max(Math.round(m * 1.5), def.durationMs.default));
      if (short >= m || long < m) {
        c.report.notes.push(
          `${def.id}: minEntranceMs ${m} cannot be checked inside durationMs ${def.durationMs.min}–${def.durationMs.max}`,
        );
      } else {
        place('short', def, fx[0]!, short);
        place('long', def, fx[0]!, long);
      }
    }
  }

  const presets = style.style.captions.presets;
  if (plan.length === 0 && presets.length === 0) return;
  progress('DOM checks (Chrome)');
  const browser = await launchChrome();
  try {
    if (plan.length > 0) {
      const p = project(style.id, { videoTracks: [track('V1'), track('V2', items)] }, media);
      const dir = await c.compile(p, { mode: 'render' }, join(work, 'dom'));
      const pages = new Map<string, HarnessPage>();
      const open = async (id: string) => {
        const pg = await openHarness(browser, dir, id, { width: W, height: H });
        pages.set(id, pg);
        return pg;
      };
      for (const it of plan.filter((x) => x.kind === 'safe')) {
        count('safe-area');
        const pg = await open(it.id);
        for (const at of [Math.round(it.dur / 2), it.dur - Math.ceil(1000 / 30)]) {
          await pg.seek(at);
          for (const b of await pg.textBoxes()) {
            const why = outsideBox(b, safe);
            if (why) {
              problem({
                rule: 'safe-area',
                template: it.def.id,
                fixture: it.fixture,
                message: `at ${at} ms "${b.text}" leaves the safe area (bottom ${safe.bottomPct} %, sides ${safe.rightPct} %): ${why}`,
              });
              break;
            }
          }
        }
        for (const e of pg.errors)
          problem({ rule: 'template-error', template: it.def.id, message: e });
      }
      for (const def of own) {
        const short = plan.find((x) => x.def === def && x.kind === 'short');
        const long = plan.find((x) => x.def === def && x.kind === 'long');
        if (!short || !long) continue;
        count('min-entrance');
        const m = def.minEntranceMs!;
        const ps = await open(short.id);
        await ps.seek(0);
        const s0 = await ps.states();
        const shot0 = await ps.screenshot();
        const pl = await open(long.id);
        await pl.seek(0);
        const long0 = await pl.screenshot();
        await pl.seek(m);
        const rest = await pl.states();
        const bad = rest.filter((r) => {
          const s = s0.find((x) => x.path === r.path);
          return !s || !sameState(s, r, jitter);
        });
        if (bad.length > 0) {
          const b = bad[0]!;
          const s = s0.find((x) => x.path === b.path);
          problem({
            rule: 'min-entrance',
            template: def.id,
            message: `at ${short.dur} ms (below minEntranceMs ${m}) frame 0 is not the resting state: element ${b.path} has opacity ${s?.opacity} transform ${s?.transform}, resting ${b.opacity} ${b.transform} (${bad.length} elements)`,
          });
        }
        if (long0.equals(shot0)) {
          problem({
            rule: 'min-entrance',
            template: def.id,
            message: `at ${long.dur} ms frame 0 looks the same as frame 0 at ${short.dur} ms: the entrance never runs, or it ignores skipEntrance`,
          });
        }
      }
      for (const pg of pages.values()) await pg.close();
    }
    for (const [i, presetId] of presets.entries()) {
      await presetChecks(c, browser, presetId, i);
    }
  } finally {
    await browser.close();
  }
}

async function presetChecks(
  c: PassCtx,
  browser: Awaited<ReturnType<typeof launchChrome>>,
  presetId: string,
  index: number,
): Promise<void> {
  const { style, media, work, problem, count } = c;
  const preset = style.captionPresets[presetId];
  if (!preset) {
    problem({
      rule: 'caption-preset',
      preset: presetId,
      message: `preset ${presetId} is not loaded`,
    });
    return;
  }
  count('caption-preset');
  const speaker: MediaItem = {
    id: 'm_a',
    kind: 'video',
    path: 'media/m_video.mp4',
    proxyPath: 'media/m_video.mp4',
    durationMs: 8000,
    width: W,
    height: H,
    hasAudio: true,
    fps: FPS,
    origin: { type: 'generated' },
    tags: [],
    transcriptPath: 'transcripts/m_a.json',
    transcriptRev: 'r1',
  };
  const p = project(
    style.id,
    {
      audioTracks: [
        track('A1', [
          { id: 'it_a1', type: 'media', mediaId: 'm_a', startMs: 0, durationMs: 3000, inMs: 0 },
        ]),
        track('A2'),
      ],
      captions: { ...structuredClone(CAPTION_DEFAULTS), preset: presetId, overrides: [] },
    },
    [...media, speaker],
  );
  const dir = await c.compile(
    p,
    { mode: 'render', layers: ['captions'] },
    join(work, `captions-${index}`),
  );
  const chunks = presetText(FIXTURE_CHUNKS, preset);
  const safe = captionSafeArea(preset, { width: W, height: H });
  const vars = (yPct: number) => ({
    chunks,
    position: { yPct },
    safeArea: safe,
    maxCharsPerLine: CAPTION_DEFAULTS.maxCharsPerLine,
  });
  const k = (i: number) => `m_a:r1:${i}`;
  const expected = new Map(
    chunks.flatMap((ch) => ch.lines.flatMap((l) => l.words.map((w) => [w.key, w.text] as const))),
  );
  const fail = (rule: string, message: string) => problem({ rule, preset: presetId, message });

  for (const yPct of [preset.position.yPct, 95]) {
    const pg = await openHarness(
      browser,
      dir,
      'captions',
      { width: W, height: H },
      { vars: vars(yPct), bg: '#3a3a3a' },
    );
    try {
      // case / stripPunctuation: the word elements carry the injected text
      await pg.seek(600);
      for (const [key, text] of expected) {
        const w = await pg.word(key);
        if (!w) {
          fail(
            'caption-preset',
            `no element with data-key="${key}" (each word element carries data-key)`,
          );
          break;
        }
        if (yPct === 95) continue;
        if (w.text !== text)
          fail(
            'caption-text',
            `word ${key} shows ${JSON.stringify(w.text)}, injected ${JSON.stringify(text)}`,
          );
      }
      // safe area: both lines of chunk 1 and chunk 2
      count('caption-safe-area');
      for (const [at, keys] of [
        [600, [0, 1, 2, 3, 4]],
        [1200, [0, 1, 2, 3, 4]],
        [2000, [5, 6]],
      ] as const) {
        await pg.seek(at);
        for (const i of keys) {
          const w = await pg.word(k(i));
          if (!w) continue;
          const why = outsideBox(w.box, safe);
          if (why) {
            fail(
              'caption-safe-area',
              `yPct ${yPct}, at ${at} ms word "${w.text}" leaves the safe area: ${why}`,
            );
            break;
          }
        }
      }
      if (yPct !== preset.position.yPct) continue;
      // word states inside word 2 (400–800 ms)
      count('caption-states');
      await pg.seek(300);
      const w2Unread = await pg.word(k(1));
      const px2Unread = w2Unread ? await pg.screenshot(w2Unread.box) : undefined;
      await pg.seek(900);
      const w2Read = await pg.word(k(1));
      const px2Read = w2Read ? await pg.screenshot(w2Read.box) : undefined;
      await pg.seek(600);
      const [w1, w2, w3] = [await pg.word(k(0)), await pg.word(k(1)), await pg.word(k(2))];
      if (w1 && w2 && w3 && w2Unread && w2Read) {
        const px2 = await pg.screenshot(w2.box);
        if (px2.equals(px2Unread!) || w2.sig === w2Unread.sig)
          fail('caption-states', 'the active word looks like an unread word');
        if (px2.equals(px2Read!) || w2.sig === w2Read.sig)
          fail('caption-states', 'the active word looks like a read word');
        if (w1.sig === w2.sig)
          fail('caption-states', 'word 1 (read) has the active look inside word 2');
        if (w3.sig === w2.sig)
          fail('caption-states', 'word 3 (unread) has the active look inside word 2');
      }
      const cell = join(work, `caption-${index}.png`);
      writeFileSync(cell, await pg.screenshot());
      c.cells.push({ file: cell, label: { kind: 'caption', preset: presetId } });
      // emphasis: its own look unread (600), active (1200), read (1450)
      count('caption-emphasis');
      const eUnread = await pg.word(k(3));
      await pg.seek(1200);
      const eActive = await pg.word(k(3));
      await pg.seek(1450);
      const eRead = await pg.word(k(3));
      const nRead = await pg.word(k(0));
      if (eUnread && w3 && eUnread.sig === w3.sig)
        fail('caption-emphasis', 'the emphasis word looks like a plain unread word');
      if (eActive && w2 && eActive.sig === w2.sig)
        fail('caption-emphasis', 'the emphasis word looks like a plain active word');
      if (eRead && nRead && eRead.sig === nRead.sig)
        fail('caption-emphasis', 'the emphasis word looks like a plain read word');
      // the same frame reached by seeking backwards is byte-identical
      count('caption-seek');
      await pg.seek(0);
      await pg.seek(600);
      const fwd = await pg.screenshot();
      await pg.seek(2400);
      await pg.seek(1200);
      await pg.seek(600);
      if (!(await pg.screenshot()).equals(fwd))
        fail('caption-seek', 'frame at 600 ms differs when reached by seeking backwards');
      for (const e of pg.errors) fail('caption-preset', `page error: ${e}`);
    } finally {
      await pg.close();
    }
  }
}

async function contactSheet(
  ffmpeg: string,
  work: string,
  cells: { file: string; label: Record<string, string> }[],
  out: string,
): Promise<void> {
  const dir = join(work, 'sheet');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cols = Math.min(6, cells.length);
  const rows = Math.ceil(cells.length / cols);
  const ff = (args: string[]) => run(ffmpeg, ['-v', 'error', '-y', ...args], { timeout: 300_000 });
  for (let i = 0; i < cols * rows; i++) {
    const dst = join(dir, `${String(i).padStart(3, '0')}.png`);
    const src = cells[i]?.file;
    if (src) await ff(['-i', src, '-vf', `scale=${CELL.w}:${CELL.h}`, dst]);
    else
      await ff([
        '-f',
        'lavfi',
        '-i',
        `color=c=0x1e1e1e:s=${CELL.w}x${CELL.h}`,
        '-frames:v',
        '1',
        dst,
      ]);
  }
  await ff([
    '-framerate',
    '1',
    '-i',
    join(dir, '%03d.png'),
    '-vf',
    `tile=${cols}x${rows}:padding=6:margin=6:color=0x1e1e1e`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    join(out, 'contact.jpg'),
  ]);
  writeFileSync(
    join(out, 'contact.json'),
    `${JSON.stringify({ columns: cols, cells: cells.map((c) => c.label) }, null, 2)}\n`,
  );
}
