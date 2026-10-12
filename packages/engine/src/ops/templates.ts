// Template-schema lookup used by scene/transition ops (styles spec "template.json").
// Phase 02 stubs it with fixture schemas; phase 03 plugs in the style registry.
import { Ajv, type ValidateFunction } from 'ajv';
import { VoxError } from '../errors.ts';
import type { Project } from '../model/schema.ts';

export type SlotKind = 'image' | 'cutout' | 'video' | 'geo' | 'template';

export interface SfxCueInfo {
  name: string;
  atMs: number | 'entrance';
  sfx: string;
  type: 'cut' | 'move' | 'land' | 'appear' | 'hero';
}

export interface TemplateInfo {
  /** `<styleId>/<name>` of the declaring style. */
  id: string;
  version: string;
  kind: 'scene' | 'transition';
  durationMs: { min: number; default: number; max: number };
  /** JSON Schema of the variables object. */
  variables: Record<string, unknown>;
  slots: Record<string, SlotKind>;
  sfxCues?: SfxCueInfo[];
  blendsShots?: boolean;
  minEntranceMs?: number;
}

/** What a caption preset gives a sequence that takes it (styles spec "Caption presets", D-93). */
export interface CaptionPresetInfo {
  position: { yPct: number };
  track?: {
    maxWords?: number;
    maxLines?: number;
    maxCharsPerLine?: number;
    autoEmphasis?: boolean;
  };
  tiered?: boolean;
}

export interface TemplateLookup {
  get(id: string): TemplateInfo | undefined;
  /** A caption preset by full id; absent or undefined = unknown (the sequence keeps its settings). */
  captionPreset?(id: string): CaptionPresetInfo | undefined;
}

export function mapTemplateLookup(list: readonly TemplateInfo[]): TemplateLookup {
  const m = new Map(list.map((t) => [t.id, t]));
  return { get: (id) => m.get(id) };
}

export const emptyTemplateLookup: TemplateLookup = { get: () => undefined };

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<TemplateInfo, ValidateFunction>();

function validator(t: TemplateInfo): ValidateFunction {
  let v = compiled.get(t);
  if (!v) {
    v = ajv.compile(t.variables);
    compiled.set(t, v);
  }
  return v;
}

export function requireTemplate(
  lookup: TemplateLookup,
  id: string,
  kind: TemplateInfo['kind'],
): TemplateInfo {
  const t = lookup.get(id);
  if (!t) {
    throw new VoxError(
      'TEMPLATE_UNKNOWN',
      `Template ${id} is not installed`,
      'Check the template id (`<styleId>/<name>`) and that its style is installed',
      { details: { template: id } },
    );
  }
  if (t.kind !== kind) {
    throw new VoxError(
      'TEMPLATE_UNKNOWN',
      `Template ${id} is a ${t.kind} template, not a ${kind} template`,
      `Use a ${kind} template here`,
      { details: { template: id } },
    );
  }
  return t;
}

/** Values found at a slot path (`items/*\/media`, `photo`); `*` walks array elements. */
export function slotValues(variables: unknown, path: string): unknown[] {
  let cur: unknown[] = [variables];
  for (const seg of path.split('/')) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (seg === '*') {
        if (Array.isArray(v)) next.push(...v);
      } else if (v !== null && typeof v === 'object' && seg in (v as object)) {
        next.push((v as Record<string, unknown>)[seg]);
      }
    }
    cur = next;
  }
  return cur.filter((v) => v !== undefined);
}

function invalidVars(template: string, why: string): VoxError {
  return new VoxError(
    'VARIABLES_INVALID',
    `Variables do not match template ${template}: ${why}`,
    'Fix the variables to match the template schema',
    { details: { template } },
  );
}

/**
 * Check variables against the template schema, recursively for `template` slots (depth 1),
 * and media slots against the project's media.
 */
export function validateVariables(
  t: TemplateInfo,
  variables: unknown,
  lookup: TemplateLookup,
  project: Project,
  depth = 0,
): void {
  const v = validator(t);
  if (!v(variables)) throw invalidVars(t.id, ajv.errorsText(v.errors));
  for (const [path, kind] of Object.entries(t.slots)) {
    for (const value of slotValues(variables, path)) {
      if (kind === 'template') {
        if (depth >= 1) throw invalidVars(t.id, `nested template slot ${path} deeper than 1`);
        const panel = value as { template?: unknown; variables?: unknown };
        if (typeof panel?.template !== 'string')
          throw invalidVars(t.id, `slot ${path} needs a template id`);
        const inner = requireTemplate(lookup, panel.template, 'scene');
        validateVariables(inner, panel.variables ?? {}, lookup, project, depth + 1);
      } else if (kind === 'image' || kind === 'cutout' || kind === 'video') {
        const media = project.media.find((m) => m.id === value);
        const want = kind === 'video' ? 'video' : 'image';
        if (!media || media.kind !== want) {
          throw invalidVars(
            t.id,
            `slot ${path} must hold the id of ${want} media (got ${JSON.stringify(value)})`,
          );
        }
      }
    }
  }
}

function propType(t: TemplateInfo, key: string): unknown {
  const props = (t.variables['properties'] ?? {}) as Record<string, { type?: unknown } | undefined>;
  const p = Object.hasOwn(props, key) ? props[key] : undefined;
  return p === undefined ? undefined : JSON.stringify(p.type ?? null);
}

/**
 * Template switch (engine spec ops table): every required target variable exists with the same
 * JSON-Schema type; slot kinds match by key; undeclared variables are dropped and listed.
 */
export function switchVariables(
  from: TemplateInfo,
  to: TemplateInfo,
  variables: Record<string, unknown>,
): { variables: Record<string, unknown>; dropped: string[] } {
  const incompatible = (why: string) =>
    new VoxError(
      'TEMPLATE_INCOMPATIBLE',
      `Cannot switch ${from.id} to ${to.id}: ${why}`,
      'Pick a template with the same required variables, or add a new scene instead',
      { details: { from: from.id, to: to.id } },
    );
  const required = (to.variables['required'] ?? []) as string[];
  for (const r of required) {
    if (!Object.hasOwn(variables, r)) throw incompatible(`required variable ${r} is missing`);
    const a = propType(from, r);
    const b = propType(to, r);
    if (a === undefined || a !== b) throw incompatible(`variable ${r} has a different type`);
  }
  const declared = to.variables['properties'] as Record<string, unknown> | undefined;
  // A filled slot of the source keeps its kind in the target (when the target keeps the variable).
  for (const [k, kind] of Object.entries(from.slots)) {
    if (slotValues(variables, k).length === 0) continue;
    const top = k.split('/')[0]!;
    if (declared && !Object.hasOwn(declared, top)) continue;
    if (to.slots[k] !== kind) throw incompatible(`slot ${k} kind differs`);
  }
  if (!declared) return { variables: { ...variables }, dropped: [] };
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(variables)) {
    if (Object.hasOwn(declared, k)) kept[k] = v;
    else dropped.push(k);
  }
  return { variables: kept, dropped: dropped.sort() };
}
