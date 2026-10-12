// Style format schemas (styles spec "Part A": `style.json`, `template.json`, caption presets;
// D-14 `sfx` object form; D-15 `minEntranceMs`, reserved `skipEntrance`, caption preset fields).
// Files are strict (an unknown key is a typo, not an extension). A child style's file may leave out
// the sections it inherits; the merged result must pass the complete `StyleSchema` (registry.ts).

import { Ajv, type ValidateFunction } from 'ajv';
import { z } from 'zod';
import { VoxError } from '../errors.ts';

const ID = /^[a-z0-9-]+$/;
const PRESET_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// Token values end up inside a generated `<style>` block, so they are allow-listed: no `;{}<>`,
// quotes, backslashes or control characters (no way out of the declaration).
const CSS_VALUE = /^[A-Za-z0-9#.,()%/ +_-]+$/;
const FONT_FAMILY = /^[A-Za-z0-9 _-]+$/;
const TOKEN_KEY = /^[a-z][a-zA-Z0-9-]*$/;
const SLOT_PATH = /^[A-Za-z0-9_-]+(?:\/(?:\*|[A-Za-z0-9_-]+))*$/;

const id = z.string().regex(ID, 'must match [a-z0-9-]+');
const semver = z.string().regex(SEMVER, 'must be a semver version (1.2.3)');
// CSS functions allowed in token values: colour and easing functions, plus GSAP ease names such as
// `back.out(1.7)`. Anything else (`url(`, `image-set(`, `var(`, …) could load a file or a URL.
const CSS_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'cubic-bezier',
  'steps',
  'linear',
]);
const GSAP_EASE = /^[a-z][a-z0-9]*\.(?:in|out|inout)$/i;

export function isCssValue(v: string): boolean {
  if (v.length === 0 || v.length > 200 || !CSS_VALUE.test(v) || v.includes('//')) return false;
  for (const m of v.matchAll(/([A-Za-z0-9._-]*)\(/g)) {
    const fn = m[1]!;
    if (!CSS_FUNCTIONS.has(fn.toLowerCase()) && !GSAP_EASE.test(fn)) return false;
  }
  return true;
}
const cssValue = z
  .string()
  .refine(isCssValue, 'must be a plain CSS value (colour or easing functions only, no url())');
const pct = (max: number) => z.number().min(0).lt(max);

/** Style-relative file path (path rule): relative, `/`-separated, no `..`, no empty segment. */
export function isStyleRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 512 || p.startsWith('/')) return false;
  // No backslash, quote, angle bracket, URL syntax (`:%?#`) or control character: paths end up in
  // CSS and HTML, and must never read as a URL or an encoded `..`.
  if (
    [...p].some(
      (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || '"<>\\:%?#'.includes(ch),
    )
  ) {
    return false;
  }
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
const stylePath = z
  .string()
  .refine(isStyleRelativePath, 'must be a path inside the style folder (relative, no ..)');

const Font = z.strictObject({
  family: z.string().min(1).max(100).regex(FONT_FAMILY, 'letters, digits, spaces, - and _ only'),
  file: stylePath,
  weight: z.int().min(1).max(1000),
});
export type Font = z.infer<typeof Font>;

const Texture = z.strictObject({
  paper: stylePath.optional(),
  grain: z.number().min(0).max(1).optional(),
});

const Motion = z.strictObject({
  easing: cssValue,
  frameHold: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  jitterPx: z.number().min(0).max(1000),
  entrance: cssValue,
});

/** CSS name part of a token key: camelCase becomes kebab-case. */
export const kebabKey = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const Colors = z
  .record(z.string().regex(TOKEN_KEY, 'token names start with a-z'), cssValue)
  .refine(
    (c) => new Set(Object.keys(c).map(kebabKey)).size === Object.keys(c).length,
    'two colour keys give the same CSS name (camelCase and kebab-case)',
  );

export const TokensSchema = z.strictObject({
  colors: Colors,
  fonts: z.strictObject({ display: Font, body: Font, caption: Font }),
  texture: Texture.optional(),
  motion: Motion,
});
export type Tokens = z.infer<typeof TokensSchema>;

const TokensPartial = z.strictObject({
  colors: Colors.optional(),
  fonts: z.strictObject({ display: Font, body: Font, caption: Font }).partial().optional(),
  texture: Texture.optional(),
  motion: Motion.partial().optional(),
});

const Range3 = z
  .strictObject({ min: z.int().positive(), target: z.int().positive(), max: z.int().positive() })
  .refine((r) => r.min <= r.target && r.target <= r.max, 'needs min <= target <= max');
const Ratio = z
  .strictObject({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) })
  .refine((r) => r.min <= r.max, 'needs min <= max');
const Pacing = z.strictObject({ beatMs: Range3, speakerRatio: Ratio });

const Imagery = z.strictObject({
  searchHints: z.array(z.string().max(200)),
  generateSuffix: z.string().max(500),
  cutoutStroke: z.strictObject({ color: cssValue, widthPx: z.number().min(0).max(100) }).optional(),
});

const Captions = z
  .strictObject({
    default: z.string().regex(PRESET_ID, 'caption preset ids are <styleId>/<preset>'),
    presets: z
      .array(z.string().regex(PRESET_ID, 'caption preset ids are <styleId>/<preset>'))
      .min(1),
  })
  .refine((c) => c.presets.includes(c.default), 'default must be one of presets')
  .refine((c) => new Set(c.presets).size === c.presets.length, 'presets are listed once');

const CueType = z.enum(['cut', 'move', 'land', 'appear', 'hero']);

const Sfx = z.record(
  z.string().regex(ID, 'sfx names match [a-z0-9-]+'),
  z.strictObject({
    path: stylePath,
    type: CueType,
    source: z.string().min(1).max(500),
    licence: z.enum(['CC0', 'project']),
  }),
);

const Overlays = z
  .array(z.strictObject({ name: id, default: z.boolean() }))
  .refine((o) => new Set(o.map((x) => x.name)).size === o.length, 'overlays are listed once');

const own = {
  id,
  name: z.string().min(1).max(100),
  version: semver,
  description: z.string().max(2000),
  status: z.enum(['active', 'draft']),
  extends: id.optional(),
  source: z.strictObject({
    type: z.enum(['builtin', 'extracted', 'user']),
    reference: z.string().max(2000).optional(),
  }),
  trusted: z.boolean(),
  templates: z.array(id),
  transitions: z.array(id),
};

function checkOwn(
  s: { id: string; extends?: string | undefined; templates: string[]; transitions: string[] },
  ctx: z.RefinementCtx,
): void {
  if (s.extends === s.id)
    ctx.addIssue({ code: 'custom', path: ['extends'], message: 'a style cannot extend itself' });
  const names = [...s.templates, ...s.transitions];
  if (new Set(names).size !== names.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['templates'],
      message: 'each template name is listed once, in templates or transitions',
    });
  }
}

/** A `style.json` as written. Sections a child inherits may be left out (merged by the registry). */
export const StyleFileSchema = z
  .strictObject({
    ...own,
    tokens: TokensPartial.optional(),
    captions: Captions.optional(),
    overlays: Overlays.optional(),
    pacing: Pacing.partial().optional(),
    imagery: Imagery.partial().optional(),
    sfx: Sfx.optional(),
  })
  .superRefine(checkOwn);
export type StyleFile = z.infer<typeof StyleFileSchema>;

/** A complete style (styles spec `Style`): a root file, or a child merged over its chain. */
export const StyleSchema = z
  .strictObject({
    ...own,
    tokens: TokensSchema,
    captions: Captions,
    overlays: Overlays,
    pacing: Pacing,
    imagery: Imagery,
    sfx: Sfx,
  })
  .superRefine(checkOwn);
export type Style = z.infer<typeof StyleSchema>;

// ---- template.json ----

// Load-time checks of a template's variables schema. `strictSchema` turns unknown keywords (typos
// such as `maxLenght`) and unknown formats into errors. A fresh Ajv per check: Ajv caches schemas by
// `$id`, so a shared instance would reject the same template on a second load.
const strictAjv = () =>
  new Ajv({
    allErrors: true,
    strictSchema: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
  });

/** True when `skipEntrance` is named anywhere as a property or a required key (D-15). */
function namesSkipEntrance(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(namesSkipEntrance);
  if (node === null || typeof node !== 'object') return false;
  const o = node as Record<string, unknown>;
  const props = o['properties'];
  if (props !== null && typeof props === 'object' && Object.hasOwn(props, 'skipEntrance')) {
    return true;
  }
  if (Array.isArray(o['required']) && o['required'].includes('skipEntrance')) return true;
  return Object.values(o).some(namesSkipEntrance);
}

function variablesProblems(schema: Record<string, unknown>): string[] {
  const ajv = strictAjv();
  if (!ajv.validateSchema(schema)) return [ajv.errorsText(ajv.errors)];
  if (schema['type'] !== 'object') return ['the variables schema must have type "object"'];
  if (namesSkipEntrance(schema)) {
    return ['skipEntrance is reserved (set by compile, D-15); a template may not declare it'];
  }
  try {
    ajv.compile(schema);
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
  return [];
}

const SfxCue = z.strictObject({
  name: z.string().min(1).max(100),
  atMs: z.union([z.int().min(0), z.literal('entrance')]),
  sfx: z.string().regex(ID),
  type: CueType,
});

export const TemplateSchema = z
  .strictObject({
    name: id,
    version: semver,
    kind: z.enum(['scene', 'transition']),
    description: z.string().max(4000),
    useWhen: z.array(z.string().max(500)),
    durationMs: z
      .strictObject({ min: z.int().min(0), default: z.int().positive(), max: z.int().positive() })
      .refine((d) => d.min <= d.default && d.default <= d.max, 'needs min <= default <= max'),
    variables: z.record(z.string(), z.unknown()),
    slots: z.record(
      z.string().regex(SLOT_PATH, 'slot paths look like photo or items/*/media'),
      z.enum(['image', 'cutout', 'video', 'geo', 'template']),
    ),
    sfxCues: z
      .array(SfxCue)
      .refine((c) => new Set(c.map((x) => x.name)).size === c.length, 'cue names are unique')
      .optional(),
    blendsShots: z.boolean().optional(),
    minEntranceMs: z.int().positive().optional(),
    // D-71: nested `template` slot panels render at this aspect (canvas width, height from the ratio)
    panelAspect: z
      .string()
      .regex(/^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/, 'panelAspect looks like 16:9')
      .optional(),
  })
  .superRefine((t, ctx) => {
    if (t.blendsShots !== undefined && t.kind !== 'transition') {
      ctx.addIssue({
        code: 'custom',
        path: ['blendsShots'],
        message: 'only transitions blend shots',
      });
    }
    if (t.minEntranceMs !== undefined && t.kind !== 'scene') {
      ctx.addIssue({
        code: 'custom',
        path: ['minEntranceMs'],
        message: 'only scenes have an entrance',
      });
    }
    if (t.panelAspect !== undefined && !Object.values(t.slots).includes('template')) {
      ctx.addIssue({
        code: 'custom',
        path: ['panelAspect'],
        message: 'only templates with a template slot have panels',
      });
    }
    for (const message of variablesProblems(t.variables)) {
      ctx.addIssue({ code: 'custom', path: ['variables'], message });
    }
  });
export type Template = z.infer<typeof TemplateSchema>;

// Lenient validator for variable values (same options as phase 02's ops), cached per schema object
// (one Ajv each, so two templates with one `$id` never collide).
const validators = new WeakMap<object, ValidateFunction>();

export function variablesValidator(schema: Record<string, unknown>): ValidateFunction {
  let v = validators.get(schema);
  if (!v) {
    v = new Ajv({ allErrors: true, strict: false }).compile(schema);
    validators.set(schema, v);
  }
  return v;
}

// ---- captions/<preset>.json (D-15) ----

const SafeArea = z.strictObject({ bottomPct: pct(100), rightPct: pct(50) });
export type SafeArea = z.infer<typeof SafeArea>;

export const CaptionPresetSchema = z.strictObject({
  name: id,
  description: z.string().max(2000),
  case: z.enum(['asis', 'upper', 'lower']),
  stripPunctuation: z.boolean(),
  safeArea: SafeArea.optional(),
  position: z.strictObject({ yPct: z.number().min(0).max(100) }),
  /**
   * Captions run behind the foreground subject on the beats where the subject overlaps them
   * (render only: Apple Vision subject matte composited over the burned-in captions). Additive
   * (GATE 8 round 3, D-91); absent = false.
   */
  behindSubject: z.boolean().optional(),
  /**
   * Caption track settings a sequence takes with the preset (with `position`), unless the call
   * that sets the preset gives its own. Additive (D-93); absent = the sequence keeps its settings.
   */
  track: z
    .strictObject({
      maxWords: z.int().min(1).max(20).optional(),
      maxLines: z.int().min(1).max(4).optional(),
      maxCharsPerLine: z.int().min(1).max(200).optional(),
      autoEmphasis: z.boolean().optional(),
    })
    .optional(),
  /**
   * Two tiers (D-93): auto emphasis also marks each phrase's closing key word (and a number's
   * unit word), and an emphasis run takes its own line after the plain words and ends the chunk.
   * Additive; absent = false.
   */
  tiered: z.boolean().optional(),
});
export type CaptionPreset = z.infer<typeof CaptionPresetSchema>;

/** The preset's safe area, or the default: 20 / 12 on 9:16, 0 / 0 otherwise (styles spec). */
export function captionSafeArea(
  preset: CaptionPreset,
  frame: { width: number; height: number },
): SafeArea {
  if (preset.safeArea) return { ...preset.safeArea };
  return frame.width * 16 === frame.height * 9
    ? { bottomPct: 20, rightPct: 12 }
    : { bottomPct: 0, rightPct: 0 };
}

// ---- parsing with VoxError ----

function issues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

function parseWith<S extends z.ZodType>(
  schema: S,
  json: unknown,
  file: string,
  what: string,
): z.infer<S> {
  const r = schema.safeParse(json);
  if (r.success) return r.data;
  const list = issues(r.error);
  throw new VoxError(
    'STYLE_INVALID',
    `${what} ${file} does not match the style format: ${list.slice(0, 3).join('; ')}`,
    'Fix the file to match the style format (styles spec "Part A")',
    { details: { file, reason: 'schema', issues: list } },
  );
}

export const parseStyleFile = (json: unknown, file: string): StyleFile =>
  parseWith(StyleFileSchema, json, file, 'Style file');
export const parseStyle = (json: unknown, file: string): Style =>
  parseWith(StyleSchema, json, file, 'Style');
export const parseTemplate = (json: unknown, file: string): Template =>
  parseWith(TemplateSchema, json, file, 'Template');
export const parseCaptionPreset = (json: unknown, file: string): CaptionPreset =>
  parseWith(CaptionPresetSchema, json, file, 'Caption preset');
