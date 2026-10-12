// Styles Part C: writes a mapped draft into the user styles folder (`~/.vox/styles/<id>/`) and its
// `report.html` (styles spec "Part C" step 5; plan phase 15). The draft is `source.type: 'extracted'`,
// `status: 'draft'`, `trusted: false` (S8) and adds no templates and no sound files (D-14). Files come
// only from the font catalogue and the parent's caption preset; the reference video is never copied
// into the style's assets. Its keyframes go to `report/` for the report page only.
import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { VoxError } from '../../errors.ts';
import { newStyleRoot } from '../manage.ts';
import { StyleFileSchema } from '../schema.ts';
import type { DraftStyle } from './map.ts';
import type { Measurements } from './measure.ts';

const ALLOWED_TARGET = /^(?:assets\/fonts\/[A-Za-z0-9-]+\.(?:ttf|txt)|captions\/reference\.html)$/;

/**
 * Writes the draft to `<last styles dir>/<id>/` through a temp folder and one rename. Fails with
 * `STYLE_DUPLICATE` when the id is installed anywhere (nothing is replaced).
 */
export function writeDraftStyle(
  stylesDirs: readonly string[],
  draft: DraftStyle,
): { id: string; dir: string } {
  const root = newStyleRoot(stylesDirs, draft.id);
  const file = StyleFileSchema.parse(draft.styleFile);
  if (
    file.id !== draft.id ||
    file.source.type !== 'extracted' ||
    file.status !== 'draft' ||
    file.trusted
  ) {
    throw new VoxError(
      'VALIDATION',
      'An extracted style must be a draft, untrusted, with source type extracted',
      'This is an engine bug; please report it.',
    );
  }
  const dir = join(root, draft.id);
  const tmp = join(root, `.${draft.id}.tmp-${String(process.pid)}-${String(Date.now())}`);
  mkdirSync(join(tmp, 'templates'), { recursive: true });
  try {
    writeFileSync(join(tmp, 'style.json'), `${JSON.stringify(file, null, 2)}\n`);
    writeFileSync(join(tmp, 'guide.md'), draft.guide);
    for (const f of draft.files) {
      if (!ALLOWED_TARGET.test(f.to)) {
        throw new VoxError('VALIDATION', `Draft file ${f.to} is not allowed`, 'Engine bug.');
      }
      mkdirSync(dirname(join(tmp, f.to)), { recursive: true });
      copyFileSync(f.from, join(tmp, f.to));
    }
    if (draft.captionPreset) {
      if (draft.captionPreset.html !== undefined) {
        mkdirSync(join(tmp, 'captions'), { recursive: true });
        writeFileSync(join(tmp, 'captions', 'reference.html'), draft.captionPreset.html);
      }
      writeFileSync(
        join(tmp, 'captions', 'reference.json'),
        `${JSON.stringify(draft.captionPreset.json, null, 2)}\n`,
      );
    }
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { id: draft.id, dir };
}

export interface ReportInput {
  draft: DraftStyle;
  measurements: Measurements;
  /** Preview files of the draft, relative to its folder (`previews/<name>.jpg`, …). */
  previews: readonly string[];
  validate: { ok: boolean; problems: string[]; notes: string[] } | null;
  /** The vision model that described the reference, or null (measurements only). */
  describedBy: string | null;
  reference: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const SAFE_COLOR = /^(?:#[0-9A-Fa-f]{3,8}|rgba?\([0-9 .,/%]+\))$/;

/** Up to `n` items spread evenly over `xs`. */
function spread<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]!);
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The report page (static HTML: no script, no remote resource; served with the untrusted-HTML CSP). */
export function reportHtml(
  r: ReportInput,
  refs: readonly { file: string; atMs: number }[],
): string {
  const d = r.draft;
  const m = r.measurements;
  const s = d.styleFile;
  const ours = r.previews.filter((p) => /^previews\/[a-z0-9-]+\.jpg$/.test(p));
  const colors = Object.entries(s.tokens?.colors ?? {});
  const cs = m.captions.summary;
  const rows = d.drivers
    .map(
      (x) =>
        `<tr><td>${esc(x.token)}</td><td>${SAFE_COLOR.test(x.value) ? `<span class="sw" style="background:${x.value}"></span>` : ''}${esc(x.value)}</td><td>${esc(x.from)}</td></tr>`,
    )
    .join('\n');
  const figs = (xs: readonly { src: string; label: string }[]) =>
    xs
      .map(
        (x) =>
          `<figure><img src="${esc(x.src)}" alt=""><figcaption>${esc(x.label)}</figcaption></figure>`,
      )
      .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(s.name)} — style report</title>
<style>
body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:20px;background:#16161a;color:#e8e8ea}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;color:#c9c9d1}
.limits{background:#2a2410;border:1px solid #6b5a1c;padding:10px 12px;border-radius:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
figure{margin:0}img{width:100%;border-radius:4px;background:#000;display:block}
figcaption{font-size:11px;color:#9a9aa3;padding-top:2px}
table{border-collapse:collapse;width:100%}td{border-top:1px solid #2c2c33;padding:4px 6px;vertical-align:top}
td:first-child{white-space:nowrap;color:#b4b4bd}.sw{display:inline-block;width:14px;height:14px;border-radius:3px;margin-right:6px;vertical-align:-2px;border:1px solid #555}
.bad{color:#ff8a80}.ok{color:#9be59b}ul{margin:4px 0;padding-left:20px}
</style></head><body>
<h1>${esc(s.name)} <small>(${esc(s.id)}, draft)</small></h1>
<p>Extracted from ${esc(r.reference)}. Extends <b>${esc(s.extends ?? 'base')}</b>. ${r.describedBy ? `Described by ${esc(r.describedBy)}.` : 'No vision model: measurements only.'}</p>
<div class="limits" id="limits"><b>Limits.</b> This draft approximates the reference's look: it copies no footage, images or brand marks, and the reference is not stored in the style's assets. Fonts are the closest free fonts, so lettering differs when the original uses a commercial typeface. Layouts no existing template matches are listed below, not built.</div>
<h2>Validation</h2>
<p>${r.validate ? (r.validate.ok ? '<span class="ok">vox style validate: ok</span>' : `<span class="bad">vox style validate: ${String(r.validate.problems.length)} problem(s)</span>`) : 'not run'}</p>
${r.validate && r.validate.problems.length ? `<ul>${r.validate.problems.map((p) => `<li class="bad">${esc(p)}</li>`).join('')}</ul>` : ''}
<h2>Reference frames and this style</h2>
<div class="cols"><section aria-label="Reference frames"><h3>Reference</h3><div class="grid">
${figs(refs.map((x) => ({ src: x.file, label: secs(x.atMs) })))}
</div></section><section aria-label="This style"><h3>Our templates in this style</h3><div class="grid">
${figs(ours.map((p) => ({ src: p, label: basename(p, '.jpg') })))}
</div></section></div>
<h2>Tokens and what drove them</h2>
<table>${rows}</table>
${colors.length ? `<p>${colors.map(([k, v]) => (SAFE_COLOR.test(v) ? `<span class="sw" style="background:${v}"></span>${esc(k)} ` : esc(k))).join(' · ')}</p>` : ''}
<h2>Measurements</h2>
<ul>
<li>${String(m.shotStats.count)} shots in ${secs(m.durationMs)}; mean ${secs(m.shotStats.meanMs)}, median ${secs(m.shotStats.medianMs)}.</li>
<li>Speaker on screen: ${m.speakerRatio === null ? 'not measured' : `${String(Math.round(m.speakerRatio * 100))} %`}.</li>
<li>Captions: ${cs.detected ? `${String(cs.captionCount)} found, about ${String(cs.wordsPerCaption)} words each, ${esc(cs.case)} case, centre at ${String(cs.yPct)} %${cs.revealShare >= 0.5 ? ', word by word' : ''}` : 'caption style not detected'}.</li>
<li>Palette: ${m.palette.map((c) => `<span class="sw" style="background:${c.hex}"></span>${esc(c.hex)} ${String(Math.round(c.share * 100))} %`).join(' ')}</li>
</ul>
<h2>Layouts</h2>
<ul>${d.matchedLayouts.map((l) => `<li>${esc(l.name)}: ${esc(l.template)}</li>`).join('')}${d.unmatchedLayouts.map((l) => `<li><b>Not built</b>: ${esc(l.name)} — ${esc(l.description)}</li>`).join('') || (d.matchedLayouts.length ? '' : '<li>No layouts described.</li>')}</ul>
${d.notes.length ? `<h2>Notes</h2><ul>${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
</body></html>
`;
}

/** Copies up to 12 reference keyframes to `<dir>/report/` and writes `<dir>/report.html`. */
export async function writeStyleReport(dir: string, r: ReportInput): Promise<string> {
  const out = join(dir, 'report');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const refs: { file: string; atMs: number }[] = [];
  for (const [i, k] of spread(r.measurements.keyframes, 12).entries()) {
    const name = `ref-${String(i + 1).padStart(2, '0')}.jpg`;
    await copyFile(k.file, join(out, name));
    refs.push({ file: `report/${name}`, atMs: k.atMs });
  }
  await writeFile(join(dir, 'report.html'), reportHtml(r, refs));
  return 'report.html';
}
