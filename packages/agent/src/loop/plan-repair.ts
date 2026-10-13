// Deterministic ClipPlan repairs for a weak editor model (D-94; plan mode, ollama qwen3.5):
// - variables that do not fit their template (an unknown key on a collage item, an invalid `align` on
//   a panel) lose the offending key or optional value instead of turning the scene into a placeholder;
// - a clip that repeats one scene template more than MAX_SAME_TEMPLATE times turns the extra beats into
//   text-led templates of the style (a collage of four stills of the speaker, four times over, adds
//   nothing). No model call.
import type { TemplateInfo, TemplateLookup } from '@vox/engine';
import { sceneTexts } from './speech-sync.ts';

/** At most this many scenes of one template per clip when the style has text-led alternatives. */
export const MAX_SAME_TEMPLATE = 2;

/** The template a missing picture or an unfit plan turns into (never chosen by a repair). */
const PLACEHOLDER = 'base/placeholder';

interface Schema {
  type?: unknown;
  enum?: unknown;
  default?: unknown;
  const?: unknown;
  pattern?: unknown;
  format?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  properties?: Record<string, Schema | undefined>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

function typeMatches(type: unknown, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObject(v);
    case 'null':
      return v === null;
    default:
      return true;
  }
}

/** The value's own checks (not its children): type, enum, const, string and number bounds. */
function ownProblem(s: Schema, v: unknown): boolean {
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, v))) return true;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => e === v)) return true;
  if (s.const !== undefined && s.const !== v) return true;
  if (typeof v === 'string') {
    const min = num(s.minLength);
    const max = num(s.maxLength);
    if (min !== undefined && [...v].length < min) return true;
    if (max !== undefined && [...v].length > max) return true;
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern, 'u').test(v)) return true;
      } catch {
        // a pattern this check cannot read is left to the engine's own check
      }
    }
  }
  if (typeof v === 'number') {
    const lo = num(s.minimum);
    const hi = num(s.maximum);
    const xlo = num(s.exclusiveMinimum);
    const xhi = num(s.exclusiveMaximum);
    if (lo !== undefined && v < lo) return true;
    if (hi !== undefined && v > hi) return true;
    if (xlo !== undefined && v <= xlo) return true;
    if (xhi !== undefined && v >= xhi) return true;
  }
  return false;
}

const shown = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

/**
 * `v` repaired against schema `s`: unknown keys of a closed object dropped, optional keys whose
 * value does not fit dropped, array entries that do not fit dropped (when the array keeps its
 * minimum), entries over the array's maximum dropped. `ok` is false when what is left still does not
 * fit (a required value that is invalid or missing): the engine's check then decides.
 */
function repairValue(
  s: Schema | undefined,
  v: unknown,
  where: string,
  note: (what: string) => void,
): { value: unknown; ok: boolean } {
  if (!isObject(s)) return { value: v, ok: true };
  if (ownProblem(s, v)) return { value: v, ok: false };
  if (isObject(v) && (s.properties !== undefined || s.additionalProperties === false)) {
    const props = (s.properties ?? {}) as Record<string, Schema | undefined>;
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const out: Record<string, unknown> = {};
    let ok = true;
    const at = (k: string) => (where === '' ? k : `${where} ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (!Object.hasOwn(props, k)) {
        if (s.additionalProperties === false) {
          note(`${where === '' ? '' : `${where}: `}unknown key ${JSON.stringify(k)} dropped`);
          continue;
        }
        out[k] = x;
        continue;
      }
      const r = repairValue(props[k], x, at(k), note);
      if (r.ok) out[k] = r.value;
      else if (required.has(k)) {
        out[k] = r.value;
        ok = false;
      } else note(`${at(k)} ${shown(x)} is not valid, dropped`);
    }
    for (const k of required) if (!Object.hasOwn(out, k)) ok = false;
    return { value: out, ok };
  }
  if (Array.isArray(v) && isObject(s.items)) {
    const min = num(s.minItems) ?? 0;
    const max = num(s.maxItems);
    const fixed = v.map((x, i) => ({
      i,
      ...repairValue(s.items as Schema, x, `${where} ${String(i)}`, note),
    }));
    const good = fixed.filter((x) => x.ok);
    let list = fixed;
    if (good.length < fixed.length && good.length >= min && good.length > 0) {
      for (const x of fixed.filter((y) => !y.ok))
        note(`${where} ${String(x.i)} ${shown(v[x.i])} is not valid, dropped`);
      list = good;
    }
    if (max !== undefined && list.length > max) {
      note(
        `${where} ${list
          .slice(max)
          .map((x) => String(x.i))
          .join(', ')} dropped (at most ${String(max)})`,
      );
      list = list.slice(0, max);
    }
    return { value: list.map((x) => x.value), ok: list.every((x) => x.ok) && list.length >= min };
  }
  return { value: v, ok: true };
}

/**
 * Scene variables fitted to their template before the engine's check (D-94, the D-90 open item):
 * unknown keys and invalid optional values are dropped (top level, array entries such as collage
 * items, nested objects, and each panel of a `template` slot against its own template), each with a
 * repair note. Required values that do not fit are left: the engine's check makes the placeholder.
 */
export function fitVariables(
  t: TemplateInfo,
  variables: Record<string, unknown>,
  templates: TemplateLookup,
  note: (what: string) => void,
  depth = 0,
): Record<string, unknown> {
  const r = repairValue(t.variables as Schema, variables, '', note);
  const out = isObject(r.value) ? r.value : variables;
  if (depth > 0) return out;
  for (const [path, kind] of Object.entries(t.slots)) {
    const m = /^([A-Za-z0-9_]+)\/\*$/.exec(path);
    const list = m ? out[m[1]!] : undefined;
    if (kind !== 'template' || !Array.isArray(list)) continue;
    out[m![1]!] = list.map((el, i) => {
      if (!isObject(el) || typeof el['template'] !== 'string' || !isObject(el['variables']))
        return el;
      const inner = templates.get(el['template']);
      if (!inner || inner.kind !== 'scene') return el;
      const pnote = (what: string) => note(`panel ${String(i)}: ${what}`);
      return { ...el, variables: fitVariables(inner, el['variables'], templates, pnote, 1) };
    });
  }
  return out;
}

/** A text-led scene template: one required free-text variable, no required picture. */
export interface TextLed {
  id: string;
  /** The variable that holds the text. */
  key: string;
}

/** Shortest text limit for a text-led template (a stat's 24-character `value` is not one). */
const TEXT_LED_MIN_CHARS = 40;

/**
 * The style's text-led scene templates (kinetic-serif, newspaper, text overlay, title): exactly one
 * required variable, a free-text string of at least TEXT_LED_MIN_CHARS characters that is not a
 * slot. The style's own templates first, then inherited `base/` ones, each in list order.
 */
export function textLedTemplates(ids: readonly string[], templates: TemplateLookup): TextLed[] {
  const out: TextLed[] = [];
  for (const id of ids) {
    const t = templates.get(id);
    if (!t || t.kind !== 'scene' || id === PLACEHOLDER) continue;
    const required = Array.isArray(t.variables['required'])
      ? (t.variables['required'] as string[])
      : [];
    if (required.length !== 1) continue;
    const key = required[0]!;
    const s = ((t.variables['properties'] ?? {}) as Record<string, Schema | undefined>)[key];
    if (s?.type !== 'string' || s.enum !== undefined || s.pattern !== undefined) continue;
    if (s.format !== undefined || t.slots[key] !== undefined) continue;
    const max = num(s.maxLength);
    if (max !== undefined && max < TEXT_LED_MIN_CHARS) continue;
    out.push({ id, key });
  }
  return [
    ...out.filter((x) => !x.id.startsWith('base/')),
    ...out.filter((x) => x.id.startsWith('base/')),
  ];
}

/** The beat fields the variety repair reads and rewrites. */
export interface VaryBeat {
  startMs: number;
  endMs: number;
  kind: 'speaker' | 'scene';
  template?: string | undefined;
  variables?: Record<string, unknown> | undefined;
  imageQueries?: string[] | undefined;
}

/** Templates a scene list uses, by count (scene beats that can apply only). */
export function templateCounts(beats: readonly VaryBeat[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of beats)
    if (b.kind === 'scene' && b.template && b.endMs > b.startMs)
      counts.set(b.template, (counts.get(b.template) ?? 0) + 1);
  return counts;
}

/**
 * The text-led template a scene turns into: the least used one under MAX_SAME_TEMPLATE that is not
 * `from` (list order on a tie), with the scene's first text; undefined when none is left or the scene
 * has no text. `counts` is updated.
 */
export function toTextLed(
  from: TemplateInfo,
  variables: Record<string, unknown>,
  textLed: readonly TextLed[],
  counts: Map<string, number>,
  templates: TemplateLookup,
): { template: string; variables: Record<string, unknown>; text: string } | undefined {
  const text = sceneTexts(from, variables, templates)[0];
  if (text === undefined) return undefined;
  const open = textLed.filter(
    (x) => x.id !== from.id && (counts.get(x.id) ?? 0) < MAX_SAME_TEMPLATE,
  );
  if (open.length === 0) return undefined;
  const pick = open.reduce((a, b) => ((counts.get(b.id) ?? 0) < (counts.get(a.id) ?? 0) ? b : a));
  counts.set(from.id, Math.max(0, (counts.get(from.id) ?? 1) - 1));
  counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1);
  return { template: pick.id, variables: { [pick.key]: text }, text };
}

/**
 * A picture-led scene template (D-102): its one required variable is an array whose entries hold a
 * picture slot and need nothing but the picture and its place (`x`, `y`): vox paper-collage. An
 * over-used beat turns into one entry of it, centred, when an image model can make the picture.
 */
export interface PictureLed {
  id: string;
  /** The array and the picture field of its entries. */
  arr: string;
  field: string;
}

/**
 * Pictures a clip gets at least when an image model is installed (D-106): text cards turn into
 * drawn pictures until this many picture-led scenes are planned. The style has one picture-led
 * template, so this is the variety cap.
 */
export const MIN_PICTURE_LED = MAX_SAME_TEMPLATE;

/** Size of the one picture a picture-led scene shows (D-102), when the entries take a `scale`. */
const PICTURE_LED_SCALE = 1.8;

/** The style's first picture-led scene template (D-102), in list order. */
export function pictureLedTemplate(
  ids: readonly string[],
  templates: TemplateLookup,
): PictureLed | undefined {
  for (const id of ids) {
    const t = templates.get(id);
    if (!t || t.kind !== 'scene' || id === PLACEHOLDER) continue;
    const required = Array.isArray(t.variables['required'])
      ? (t.variables['required'] as string[])
      : [];
    if (required.length !== 1) continue;
    const arr = required[0]!;
    const slot = Object.entries(t.slots).find(
      ([path, kind]) => path.startsWith(`${arr}/*/`) && (kind === 'image' || kind === 'cutout'),
    );
    if (!slot) continue;
    const field = slot[0].slice(arr.length + 3);
    const item = (((t.variables['properties'] ?? {}) as Record<string, Schema | undefined>)[arr]
      ?.items ?? {}) as Schema;
    const needs = Array.isArray(item.required) ? (item.required as unknown[]) : [];
    if (needs.every((k) => k === field || k === 'x' || k === 'y')) return { id, arr, field };
  }
  return undefined;
}

/** The variables of a picture-led scene with one centred picture, left empty for the run to fill. */
function pictureLedVariables(p: PictureLed, templates: TemplateLookup): Record<string, unknown> {
  const t = templates.get(p.id);
  const item = (((t?.variables['properties'] ?? {}) as Record<string, Schema | undefined>)[p.arr]
    ?.items ?? {}) as Schema;
  const scaled = item.properties?.['scale'] !== undefined;
  return {
    [p.arr]: [{ [p.field]: '', x: 50, y: 42, ...(scaled && { scale: PICTURE_LED_SCALE }) }],
  };
}

/** Where the one drawn picture sits over captions burned in mid-frame (D-107). */
export const PICTURE_ABOVE = { y: 25, scale: 1.5 } as const;

/**
 * D-107, demo run 8: the centred picture (y 42, 1.8) spans about 21 to 63 % of a 9:16 frame, so
 * captions at 50 % ran across it. With captions between 35 and 70 % the one entry moves up and
 * shrinks (PICTURE_ABOVE: about 7 to 43 %); otherwise, or with more entries, nothing changes.
 */
export function pictureAboveCaptions(
  p: PictureLed,
  variables: Record<string, unknown>,
  captionY: number | undefined,
  note: (what: string) => void,
): Record<string, unknown> {
  if (captionY === undefined || captionY < 35 || captionY > 70) return variables;
  const arr = variables[p.arr];
  if (!Array.isArray(arr) || arr.length !== 1) return variables;
  const e = arr[0] as Record<string, unknown>;
  note(
    `picture moved up to ${String(PICTURE_ABOVE.y)} % (clear of the captions at ${String(captionY)} %)`,
  );
  return {
    ...variables,
    [p.arr]: [
      { ...e, y: PICTURE_ABOVE.y, ...(e['scale'] !== undefined && { scale: PICTURE_ABOVE.scale }) },
    ],
  };
}

/**
 * Scene variety of one sequence's beats (D-94): a template used more than MAX_SAME_TEMPLATE times
 * keeps its beats with image queries first, then the earliest; each other beat turns into a text-led
 * template of the style with the beat's first text (`toTextLed`). With `pictureLed` (D-102: an image
 * model is installed), the first of those beats turn into it instead (one picture, no text, up to
 * MAX_SAME_TEMPLATE of it); `illustrated` maps each such beat to its text, which the run draws.
 * D-103: a picture-led beat planned with its array empty or left out (run 6: `items: []` and a
 * label) gets the one centred entry too, drawn from its own text, instead of turning text-led.
 * D-106: then text-led beats turn picture-led until MIN_PICTURE_LED are planned: never the first
 * scene (the hook), beats long enough for the picture-led template first, then the longest text.
 * Beats with no text, or when every template is used up, stay as planned. Returns the beats (input
 * order) and the notes by beat index.
 */
export function varySceneTemplates<B extends VaryBeat>(
  beats: readonly B[],
  textLed: readonly TextLed[],
  templates: TemplateLookup,
  pictureLed?: PictureLed,
): {
  beats: B[];
  notes: { beat: number; what: string }[];
  counts: Map<string, number>;
  illustrated: Map<number, string>;
} {
  const out = [...beats];
  const notes: { beat: number; what: string }[] = [];
  const counts = templateCounts(beats);
  const illustrated = new Map<number, string>();
  for (const [id, n] of [...counts.entries()]) {
    if (n <= MAX_SAME_TEMPLATE || id === PLACEHOLDER) continue;
    const from = templates.get(id);
    if (!from || from.kind !== 'scene') continue;
    const mine = out
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.kind === 'scene' && b.template === id && b.endMs > b.startMs)
      .sort(
        (x, y) =>
          Number((y.b.imageQueries?.length ?? 0) > 0) -
            Number((x.b.imageQueries?.length ?? 0) > 0) ||
          x.b.startMs - y.b.startMs ||
          x.i - y.i,
      );
    for (const { b, i } of mine.slice(MAX_SAME_TEMPLATE)) {
      const text = sceneTexts(from, b.variables ?? {}, templates)[0];
      if (
        pictureLed &&
        text !== undefined &&
        pictureLed.id !== id &&
        (counts.get(pictureLed.id) ?? 0) < MAX_SAME_TEMPLATE
      ) {
        counts.set(id, Math.max(0, (counts.get(id) ?? 1) - 1));
        counts.set(pictureLed.id, (counts.get(pictureLed.id) ?? 0) + 1);
        const rest: VaryBeat = { ...b };
        delete rest.imageQueries;
        out[i] = {
          ...rest,
          template: pictureLed.id,
          variables: pictureLedVariables(pictureLed, templates),
        } as B;
        illustrated.set(i, text);
        notes.push({
          beat: i,
          what: `${id} planned ${String(n)} times: this one is ${pictureLed.id} with a picture of ${JSON.stringify(text)} (at most ${String(MAX_SAME_TEMPLATE)} of a template)`,
        });
        continue;
      }
      const to = toTextLed(from, b.variables ?? {}, textLed, counts, templates);
      if (!to) continue;
      const rest: VaryBeat = { ...b };
      delete rest.imageQueries;
      out[i] = { ...rest, template: to.template, variables: to.variables } as B;
      notes.push({
        beat: i,
        what: `${id} planned ${String(n)} times: this one is ${to.template} ${JSON.stringify(to.text)} (at most ${String(MAX_SAME_TEMPLATE)} of a template)`,
      });
    }
  }
  if (pictureLed)
    for (const [i, b] of out.entries()) {
      if (b.kind !== 'scene' || b.template !== pictureLed.id || illustrated.has(i)) continue;
      const list = b.variables?.[pictureLed.arr];
      if (Array.isArray(list) && list.length > 0) continue;
      const t = templates.get(pictureLed.id);
      const text = t ? sceneTexts(t, b.variables ?? {}, templates)[0] : undefined;
      if (text === undefined) continue;
      out[i] = {
        ...b,
        variables: { ...b.variables, ...pictureLedVariables(pictureLed, templates) },
      };
      illustrated.set(i, text);
      notes.push({
        beat: i,
        what: `${pictureLed.id} planned with no ${pictureLed.arr}: one picture of ${JSON.stringify(text)}`,
      });
    }
  if (pictureLed) {
    const pic = templates.get(pictureLed.id);
    const led = new Set(textLed.map((x) => x.id));
    const scenes = out
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.kind === 'scene' && b.endMs > b.startMs)
      .sort((x, y) => x.b.startMs - y.b.startMs || x.i - y.i);
    const minMs = pic?.durationMs.min ?? 0;
    const open = scenes
      .slice(1)
      .flatMap(({ b, i }) => {
        const from = b.template ? templates.get(b.template) : undefined;
        if (!from || !led.has(from.id)) return [];
        const text = sceneTexts(from, b.variables ?? {}, templates)[0];
        return text === undefined ? [] : [{ b, i, text, fits: b.endMs - b.startMs >= minMs }];
      })
      .sort(
        (x, y) =>
          Number(y.fits) - Number(x.fits) ||
          y.text.length - x.text.length ||
          x.b.startMs - y.b.startMs,
      );
    for (const { b, i, text } of open) {
      if ((counts.get(pictureLed.id) ?? 0) >= MIN_PICTURE_LED) break;
      const id = b.template!;
      counts.set(id, Math.max(0, (counts.get(id) ?? 1) - 1));
      counts.set(pictureLed.id, (counts.get(pictureLed.id) ?? 0) + 1);
      const rest: VaryBeat = { ...b };
      delete rest.imageQueries;
      out[i] = {
        ...rest,
        template: pictureLed.id,
        variables: pictureLedVariables(pictureLed, templates),
      } as B;
      illustrated.set(i, text);
      notes.push({
        beat: i,
        what: `${id} ${JSON.stringify(text)}: ${pictureLed.id} with a picture of it instead (at least ${String(MIN_PICTURE_LED)} pictures with an image model)`,
      });
    }
  }
  return { beats: out, notes, counts, illustrated };
}

/**
 * Where a `position` choice puts a scene's text block, in % of the frame height (its top edge and
 * its height for two lines): `base/text-overlay` (`top: 12%`, `middle: 42%`, `bottom: 56%`).
 */
const POSITION_BANDS: Record<string, { topPct: number; heightPct: number }> = {
  top: { topPct: 12, heightPct: 12 },
  middle: { topPct: 42, heightPct: 12 },
  bottom: { topPct: 56, heightPct: 12 },
};
/** Half the height of a two-line caption block around its `yPct` (two-tier presets). */
export const CAPTION_HALF_PCT = 9;

const bandClear = (pos: string, yPct: number) => {
  const b = POSITION_BANDS[pos]!;
  return b.topPct + b.heightPct <= yPct - CAPTION_HALF_PCT || b.topPct >= yPct + CAPTION_HALF_PCT;
};
const bandGap = (pos: string, yPct: number) => {
  const b = POSITION_BANDS[pos]!;
  return Math.abs(b.topPct + b.heightPct / 2 - yPct);
};

/**
 * A scene with a `position` choice (top, middle, bottom) clear of burned-in captions at `yPct`
 * (D-96: a text overlay at the bottom sat on the two-tier captions at 50 %): kept when its band is
 * clear of the caption block, else moved to the clear choice farthest from the captions, with a
 * repair note. Unchanged without captions or a `position` enum.
 */
export function clearOfCaptions(
  t: TemplateInfo,
  variables: Record<string, unknown>,
  captionYPct: number | undefined,
  note: (what: string) => void,
): Record<string, unknown> {
  if (captionYPct === undefined) return variables;
  const props = (t.variables['properties'] ?? {}) as Record<string, Schema | undefined>;
  const s = props['position'];
  if (!s || !Array.isArray(s.enum)) return variables;
  const choices = (s.enum as unknown[]).filter(
    (v): v is string => typeof v === 'string' && Object.hasOwn(POSITION_BANDS, v),
  );
  const cur = typeof variables['position'] === 'string' ? variables['position'] : s.default;
  if (typeof cur === 'string' && Object.hasOwn(POSITION_BANDS, cur) && bandClear(cur, captionYPct))
    return variables;
  const clear = choices.filter((c) => bandClear(c, captionYPct));
  if (clear.length === 0) return variables;
  const pick = clear.reduce((a, b) => (bandGap(b, captionYPct) > bandGap(a, captionYPct) ? b : a));
  note(
    `position ${typeof cur === 'string' ? cur : 'default'} → ${pick} (clear of the captions at ${String(captionYPct)} %)`,
  );
  return { ...variables, position: pick };
}
