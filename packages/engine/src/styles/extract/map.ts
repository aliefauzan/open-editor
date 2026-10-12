// Styles Part C step 4, "Map" (styles spec "Part C"; plan phase 15): measurements plus the optional
// vision description → a draft child style that re-skins existing templates (no new templates).
// Deterministic: the same inputs give the same draft. Colours come from the measured palette,
// pacing from the shot list, the caption preset position and case from OCR, fonts from the bundled
// catalogue, motion, texture and overlays from the description. Without a description the draft
// keeps the parent's fonts, motion, texture and overlays (and says so in its notes).
import { join } from 'node:path';
import type { ResolvedStyle, StyleSummary } from '../registry.ts';
import type { CaptionPreset, StyleFile } from '../schema.ts';
import { twoTierHtml, twoTierLook, twoTierTrack } from './caption-preset.ts';
import { closestFont, familyFiles, type FontCatalogue, type FontEntry } from './catalogue.ts';
import type { StyleDescription } from './description.ts';
import type { Measurements, PaletteColor } from './measure.ts';

export interface StyleSource {
  list(): StyleSummary[];
  get(id: string): ResolvedStyle;
  defaultId(): string;
}

export interface MapInput {
  id: string;
  name: string;
  /** Shown in `source.reference`: a link, or the file name (never a full local path). */
  reference: string;
  measurements: Measurements;
  description: StyleDescription | null;
  styles: StyleSource;
  catalogue: FontCatalogue;
}

export interface DraftFile {
  /** Absolute source path (a catalogue font, its licence, or a parent caption preset). */
  from: string;
  /** Path inside the draft style folder. */
  to: string;
}

export interface DraftStyle {
  id: string;
  styleFile: StyleFile;
  guide: string;
  files: DraftFile[];
  /**
   * Own caption preset (`captions/reference.json`): copied from `basedOn` with measured case and
   * position, or (`html`) the measured two-tier preset written from the engine template.
   */
  captionPreset: { name: string; json: CaptionPreset; basedOn: string; html?: string } | null;
  matchedLayouts: { name: string; template: string }[];
  unmatchedLayouts: { name: string; description: string }[];
  /** Which measurement or description drove each token (for the report). */
  drivers: { token: string; value: string; from: string }[];
  notes: string[];
}

// ---- colour helpers ----

function hueOf(c: PaletteColor): number {
  const [r, g, b] = c.rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const isHex = (v: string) => /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(v);

export type ColorRole = 'background' | 'ink' | 'accent' | 'highlight' | 'blue';

/** Palette colours per role; a role with no fitting colour is missing (the parent's stays). */
export function paletteRoles(
  palette: readonly PaletteColor[],
): Partial<Record<ColorRole, PaletteColor>> {
  const out: Partial<Record<ColorRole, PaletteColor>> = {};
  const big = palette.filter((c) => c.share >= 0.01);
  if (big.length === 0) return out;
  out.background = big.find((c) => c.lightness >= 0.55 && c.saturation < 0.5) ?? big[0];
  const darkest = [...big].sort((a, b) => a.lightness - b.lightness)[0]!;
  if (darkest.lightness <= 0.35 && darkest !== out.background) out.ink = darkest;
  const vivid = big
    .filter((c) => c !== out.background && c !== out.ink)
    .filter((c) => c.saturation >= 0.35 && c.lightness >= 0.2 && c.lightness <= 0.8)
    .sort((a, b) => b.saturation * b.share ** 0.25 - a.saturation * a.share ** 0.25);
  if (vivid[0]) out.accent = vivid[0];
  const second = vivid.find((c) => c !== out.accent && hueGap(hueOf(c), hueOf(out.accent!)) >= 40);
  if (second) out.highlight = second;
  const blue = big.find((c) => {
    const h = hueOf(c);
    return (
      h >= 190 && h <= 250 && c.saturation >= 0.3 && c.lightness >= 0.15 && c.lightness <= 0.75
    );
  });
  if (blue) out.blue = blue;
  return out;
}

/** The colour role a token key plays, from its name; null = not a palette colour. */
export function roleOfKey(key: string): ColorRole | 'captionText' | 'captionBox' | null {
  const k = key.toLowerCase();
  if (k === 'caption') return 'captionText';
  if (k === 'captionbox' || k === 'captionplate') return 'captionBox';
  if (k.startsWith('caption')) return null;
  if (/paper|background|^bg|canvas|^base/.test(k)) return 'background';
  if (/ink|text|^fg|foreground|^dark/.test(k)) return 'ink';
  if (/accent|primary|brand/.test(k)) return 'accent';
  if (/highlight|secondary|marker/.test(k)) return 'highlight';
  if (/sea|water|blue/.test(k)) return 'blue';
  return null;
}

// ---- small helpers ----

const round50 = (n: number) => Math.max(50, Math.round(n / 50) * 50);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Measured noise (8-bit levels at 720 px short side, `vox_py.grain`) a unit of the grain token adds
 * in a render: vox/paper-grain at grain 0.5 over a talking head, `--quality standard`, measured
 * about 4.6 on the speaker frames (D-93).
 */
export const GRAIN_SIGMA_PER_UNIT = 9;
/** Below this grain the paper-grain overlay shows nothing worth its cost: off by default. */
export const GRAIN_OVERLAY_MIN = 0.04;

/** The grain token that adds the measured noise (0 to 0.5, two decimals). */
export function grainFromSigma(sigma: number): number {
  return r2(clamp(sigma / GRAIN_SIGMA_PER_UNIT, 0, 0.5));
}

/** Free model text, made safe for markdown and prompts: one line, no tags, no control characters. */
export function plainText(s: string, max = 300): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
      .replace(/[<>`#*_[\]{}|\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

function pickParent(input: MapInput): { id: string; why: string } {
  const fallback = input.styles.defaultId();
  const d = input.description;
  if (!d) return { id: fallback, why: 'no description: the default style' };
  const builtins = input.styles
    .list()
    .filter((s) => s.source.type === 'builtin' && s.status === 'active');
  let best = { id: fallback, score: -1, why: 'the default style' };
  for (const s of builtins) {
    let r: ResolvedStyle;
    try {
      r = input.styles.get(s.id);
    } catch {
      continue;
    }
    let score = 0;
    for (const l of d.layouts) {
      const t = l.closestTemplate ? r.templates[l.closestTemplate] : undefined;
      if (t && t.styleId === s.id) score += 2;
      else if (t) score += 1;
    }
    if ((d.texture.paper || d.texture.grain >= 0.1) && r.files.texture?.paper) score += 2;
    if (score > best.score || (score === best.score && s.id === fallback)) {
      best = {
        id: s.id,
        score,
        why: `${String(score)} point(s) from matching layouts and texture`,
      };
    }
  }
  return { id: best.id, why: best.why };
}

function matchTemplate(parent: ResolvedStyle, wanted: string | null): string | null {
  if (!wanted) return null;
  if (parent.templates[wanted]?.kind === 'scene') return wanted;
  const short = wanted.split('/').pop()!;
  const hit = Object.values(parent.templates).find(
    (t) => t.kind === 'scene' && t.id.split('/').pop() === short,
  );
  return hit?.id ?? null;
}

function presetScore(
  p: ResolvedStyle['captionPresets'][string],
  want: { case: string; yPct: number; boxed: boolean | null; wordByWord: boolean },
): number {
  const text = `${p.name} ${p.description}`.toLowerCase();
  let s = 0;
  if (p.case === want.case) s += 3;
  if (want.boxed !== null && /box|plate/.test(text) === want.boxed) s += 2;
  if (/word-by-word|word by word|reveal/.test(text) === want.wordByWord) s += 2;
  s -= Math.abs(p.position.yPct - want.yPct) / 20;
  return s;
}

// ---- the map step ----

/** Maps measurements (+ description) to a draft style. Pure: reads only the given registry. */
export function mapDraftStyle(input: MapInput): DraftStyle {
  const m = input.measurements;
  const d = input.description;
  const notes: string[] = [...m.notes];
  const drivers: DraftStyle['drivers'] = [];
  const files: DraftFile[] = [];
  const { id: parentId, why } = pickParent(input);
  const parent = input.styles.get(parentId);
  drivers.push({ token: 'extends', value: parentId, from: why });
  if (!d) {
    notes.push(
      'No vision description: fonts, motion, texture, overlays and layouts follow the parent style.',
    );
  }

  // colours
  const roles = paletteRoles(m.palette);
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent.style.tokens.colors)) {
    const role = roleOfKey(key);
    if (!isHex(value) && role !== 'captionBox') continue;
    let pick: string | undefined;
    let from = '';
    if (role === 'captionText' && d?.captions.textColor) {
      pick = d.captions.textColor.toUpperCase();
      from = 'description: caption text colour';
    } else if (role === 'captionBox' && d?.captions.boxed && d.captions.boxColor) {
      pick = d.captions.boxColor.toUpperCase();
      from = 'description: caption box colour';
    } else if (role && role !== 'captionText' && role !== 'captionBox' && roles[role]) {
      const c = roles[role];
      pick = c.hex;
      from = `palette: ${role} (${String(Math.round(c.share * 100))} % of keyframe pixels)`;
    }
    if (pick && pick.toLowerCase() !== value.toLowerCase()) {
      colors[key] = pick;
      drivers.push({ token: `colors.${key}`, value: pick, from });
    }
  }

  // fonts: the measured caption tiers first (tier 1 = body and display, tier 2 = caption), then the
  // description for the roles left
  const fonts: NonNullable<NonNullable<StyleFile['tokens']>['fonts']> = {};
  const copyFamily = (entries: readonly FontEntry[]) => {
    for (const e of entries) {
      const file = `assets/fonts/${e.file}`;
      if (!files.some((f) => f.to === file))
        files.push({ from: join(input.catalogue.dir, e.file), to: file });
      const lic = `assets/fonts/${e.licenceFile}`;
      if (!files.some((f) => f.to === lic))
        files.push({ from: join(input.catalogue.dir, e.licenceFile), to: lic });
    }
  };
  const tiers = m.fonts?.tiers ?? [];
  for (const t of tiers) {
    const roles = t.tier === 1 ? (['body', 'display'] as const) : (['caption'] as const);
    const all = familyFiles(input.catalogue, t.pick.family);
    // the token names the upright file; the italic file sits beside it (compile adds the face)
    const upright =
      all
        .filter((e) => !e.italic)
        .sort(
          (a, b) =>
            Math.abs(a.weights.min - t.pick.weight) - Math.abs(b.weights.min - t.pick.weight),
        )[0] ?? all[0];
    if (!upright) continue;
    copyFamily(all);
    const weight = Math.min(upright.weights.max, Math.max(upright.weights.min, t.pick.weight));
    for (const role of roles) {
      fonts[role] = { family: upright.family, file: `assets/fonts/${upright.file}`, weight };
      drivers.push({
        token: `fonts.${role}`,
        value: `${upright.family}${t.pick.italic ? ' (italic)' : ''} ${String(weight)}`,
        from: `measured: tier ${String(t.tier)} caption lines (${String(t.lines)}), glyph match score ${t.pick.score.toFixed(3)}${t.runnersUp[0] ? `; next ${t.runnersUp[0].family}${t.runnersUp[0].italic ? ' italic' : ''} ${t.runnersUp[0].score.toFixed(3)}` : ''}`,
      });
    }
  }
  if (d) {
    for (const role of ['display', 'body', 'caption'] as const) {
      if (fonts[role]) continue;
      const want = d.fonts[role];
      const pick = closestFont(input.catalogue, {
        classification: want.classification,
        weight: want.weight,
        tags: want.tags.map((t) => plainText(t, 40).toLowerCase()),
      });
      fonts[role] = {
        family: pick.entry.family,
        file: `assets/fonts/${pick.entry.file}`,
        weight: pick.weight,
      };
      copyFamily([pick.entry]);
      drivers.push({
        token: `fonts.${role}`,
        value: `${pick.entry.family} ${String(pick.weight)}`,
        from: `description: ${want.classification}, weight ${String(want.weight)}${want.tags.length ? `, ${want.tags.map((t) => plainText(t, 40)).join(', ')}` : ''}`,
      });
    }
  }

  // motion and texture; grain is measured when it can be (D-93), else described
  const motion: NonNullable<NonNullable<StyleFile['tokens']>['motion']> = {};
  let texture: NonNullable<NonNullable<StyleFile['tokens']>['texture']> | undefined;
  const measuredGrain = m.grain ? grainFromSigma(m.grain.sigma) : undefined;
  if (m.grain && measuredGrain !== undefined) {
    texture = { grain: measuredGrain };
    drivers.push({
      token: 'texture.grain',
      value: String(measuredGrain),
      from: `measured: noise ${String(m.grain.sigma)} levels in flat mid-tones (${String(m.grain.frames)} frames)`,
    });
  }
  if (d) {
    const pop = d.motion.entrance === 'pop';
    motion.frameHold = d.motion.frameHold;
    motion.entrance = pop ? 'pop' : 'fade';
    motion.easing = pop ? 'back.out(1.6)' : 'power2.out';
    motion.jitterPx = d.motion.frameHold > 1 ? Math.max(parent.style.tokens.motion.jitterPx, 2) : 0;
    drivers.push({
      token: 'motion',
      value: `${motion.entrance}, hold ${String(motion.frameHold)}`,
      from: `description: entrance ${d.motion.entrance}, frame hold ${String(d.motion.frameHold)}`,
    });
    if (d.motion.entrance === 'slide')
      notes.push('Slide entrances are not a template option: the draft uses fade.');
    if (measuredGrain === undefined) {
      texture = { grain: r2(d.texture.grain) };
      drivers.push({
        token: 'texture.grain',
        value: String(texture.grain),
        from: 'description: texture',
      });
    }
  }

  // overlays
  let overlays: StyleFile['overlays'];
  if ((d || measuredGrain !== undefined) && parent.overlays.length > 0) {
    const grainOn =
      measuredGrain !== undefined
        ? measuredGrain >= GRAIN_OVERLAY_MIN || (d?.texture.paper ?? false)
        : d!.texture.paper || d!.texture.grain >= 0.1;
    overlays = parent.overlays.map((o) => ({
      name: o.name,
      default:
        o.name === 'paper-grain'
          ? grainOn
          : o.name === 'film-look'
            ? (d?.texture.film ?? o.default)
            : o.default,
    }));
    drivers.push({
      token: 'overlays',
      value:
        overlays
          .filter((o) => o.default)
          .map((o) => o.name)
          .join(', ') || 'none on',
      from:
        measuredGrain !== undefined
          ? `measured grain${d ? '; description: paper, film' : ''}`
          : 'description: texture (paper, grain, film)',
    });
  }

  // pacing
  const pacing: NonNullable<StyleFile['pacing']> = {};
  const st = m.shotStats;
  if (st.count >= 2) {
    const target = round50(clamp(st.meanMs, 300, 30_000));
    pacing.beatMs = {
      min: Math.min(round50(st.p10Ms), target),
      target,
      max: Math.max(round50(st.p90Ms), target),
    };
    drivers.push({
      token: 'pacing.beatMs',
      value: `${String(pacing.beatMs.min)} / ${String(target)} / ${String(pacing.beatMs.max)} ms`,
      from: `shots: ${String(st.count)} shots, mean ${String(st.meanMs)} ms, p10 ${String(st.p10Ms)} ms, p90 ${String(st.p90Ms)} ms`,
    });
  } else notes.push('No cuts found in the reference: the draft keeps the parent pacing.');
  if (m.speakerRatio !== null) {
    pacing.speakerRatio = {
      min: r2(clamp(m.speakerRatio - 0.1, 0, 1)),
      max: r2(clamp(m.speakerRatio + 0.1, 0, 1)),
    };
    drivers.push({
      token: 'pacing.speakerRatio',
      value: `${String(pacing.speakerRatio.min)}–${String(pacing.speakerRatio.max)}`,
      from: `facetrack: speaker on screen ${String(Math.round(m.speakerRatio * 100))} % of the time`,
    });
  }

  // captions
  let captionPreset: DraftStyle['captionPreset'] = null;
  let captions: StyleFile['captions'];
  const cs = m.captions.summary;
  if (cs.detected) {
    const want = {
      case: cs.case,
      yPct: cs.yPct,
      boxed: d ? d.captions.boxed : null,
      wordByWord: cs.revealShare >= 0.5 || (d?.captions.wordByWord ?? false),
    };
    const presets = Object.values(parent.captionPresets);
    const base = [...presets].sort(
      (a, b) => presetScore(b, want) - presetScore(a, want) || a.id.localeCompare(b.id),
    )[0];
    // inside the 9:16 caption safe area (bottom 20 %), with room for two lines
    const yPct = Math.round(clamp(cs.yPct, 12, 74));
    const own = `${input.id}/reference`;
    if (m.fonts && tiers.length > 0) {
      const look = twoTierLook(m.fonts);
      const t1 = tiers.find((t) => t.tier === 1);
      const t2 = tiers.find((t) => t.tier === 2);
      const parts = [
        t1 ? `${t1.pick.family}${t1.pick.italic ? ' italic' : ''} lines` : 'body-font lines',
        `emphasis words${t2 ? ` in ${t2.pick.family}` : ''} upper case in a ${look.box.knockout ? 'cut-out ' : ''}box`,
        ...(look.fringe > 0 ? ['a red/cyan fringe'] : []),
        ...(look.reveal ? ['single words tightening in'] : []),
        ...(look.behindSubject ? ['behind the subject where it overlaps'] : []),
      ];
      const json: CaptionPreset = {
        name: 'reference',
        description: `Measured from the reference: two tiers at ${String(Math.round(cs.yPct))} % height: ${parts.join(', ')}.`,
        case: cs.case,
        stripPunctuation: false,
        position: { yPct },
        ...(look.behindSubject ? { behindSubject: true } : {}),
        track: twoTierTrack(m.captions.events),
        tiered: true,
      };
      captionPreset = {
        name: 'reference',
        json,
        basedOn: 'measured two-tier',
        html: twoTierHtml(look),
      };
      captions = { default: own, presets: [own, ...presets.map((p) => p.id)] };
      drivers.push({
        token: 'captions',
        value: `${own} (two tiers), ${String(yPct)} %, ${String(json.track!.maxWords)} words / ${String(json.track!.maxCharsPerLine)} characters a line, key words boxed`,
        from: `fonts: ${tiers.map((t) => `tier ${String(t.tier)} ${String(t.lines)} lines`).join(', ')}; two tiers in ${String(Math.round(m.fonts.twoTierShare * 100))} % of sampled frames; box ${look.box.fill}${look.box.knockout ? ' cut-out' : ''}${look.box.rule ? ' with edge line' : ''}; fringe ${look.fringe > 0 ? `${String(look.fringe)} px` : 'none'}`,
      });
      drivers.push({
        token: 'captions.behindSubject',
        value: String(look.behindSubject),
        from: m.fonts.occlusion.available
          ? `occlusion: captions behind the subject in ${String(m.fonts.occlusion.behind)} of ${String(m.fonts.occlusion.decided)} frames that could tell (${String(m.fonts.occlusion.frames)} checked)`
          : 'occlusion: not checked (needs Apple Vision, macOS 14 or later)',
      });
      drivers.push({
        token: 'captions.trackingReveal',
        value: String(look.reveal),
        from: `OCR: ${String(m.fonts.trackingReveal.events)} of ${String(m.fonts.trackingReveal.of)} single-word captions change their letter spacing`,
      });
      if (yPct !== Math.round(cs.yPct))
        notes.push(
          `Captions sit at ${String(Math.round(cs.yPct))} % in the reference; the preset uses ${String(yPct)} % to stay inside the caption safe area.`,
        );
    } else if (base) {
      const json: CaptionPreset = {
        name: 'reference',
        description: `Measured from the reference: ${cs.case === 'asis' ? 'mixed' : cs.case}-case captions at ${String(Math.round(cs.yPct))} % height, about ${String(cs.wordsPerCaption)} words each${want.wordByWord ? ', revealed word by word' : ''}. Look of ${base.id}.`,
        case: cs.case,
        stripPunctuation: base.stripPunctuation,
        ...(base.safeArea ? { safeArea: base.safeArea } : {}),
        position: { yPct },
      };
      captionPreset = { name: 'reference', json, basedOn: base.id };
      files.push({ from: base.htmlPath, to: 'captions/reference.html' });
      captions = { default: own, presets: [own, ...presets.map((p) => p.id)] };
      drivers.push({
        token: 'captions',
        value: `${own} (look of ${base.id}), ${cs.case}, ${String(yPct)} %`,
        from: `OCR: ${String(cs.captionCount)} captions, ${String(cs.wordsPerCaption)} words each, centre at ${String(cs.yPct)} %, case ${cs.case}`,
      });
      if (yPct !== Math.round(cs.yPct))
        notes.push(
          `Captions sit at ${String(Math.round(cs.yPct))} % in the reference; the preset uses ${String(yPct)} % to stay inside the caption safe area.`,
        );
    }
  }

  // layouts
  const matchedLayouts: DraftStyle['matchedLayouts'] = [];
  const unmatchedLayouts: DraftStyle['unmatchedLayouts'] = [];
  for (const l of d?.layouts ?? []) {
    const t = matchTemplate(parent, l.closestTemplate);
    if (t) matchedLayouts.push({ name: plainText(l.name, 80), template: t });
    else
      unmatchedLayouts.push({
        name: plainText(l.name, 80),
        description: plainText(l.description, 300),
      });
  }

  const tokens: NonNullable<StyleFile['tokens']> = {
    ...(Object.keys(colors).length ? { colors } : {}),
    ...(Object.keys(fonts).length ? { fonts } : {}),
    ...(Object.keys(motion).length ? { motion } : {}),
    ...(texture ? { texture } : {}),
  };
  const imagery = (d?.imagery ?? []).map((s) => plainText(s, 80)).filter(Boolean);
  const styleFile: StyleFile = {
    id: input.id,
    name: plainText(input.name, 100) || input.id,
    version: '0.1.0',
    description: `Draft style extracted from a reference video (${plainText(input.reference, 200)}): re-skins ${parentId}'s templates with measured colours, pacing and captions.`,
    status: 'draft',
    extends: parentId,
    source: { type: 'extracted', reference: plainText(input.reference, 2000) },
    trusted: false,
    templates: [],
    transitions: [],
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(captions ? { captions } : {}),
    ...(overlays ? { overlays } : {}),
    ...(Object.keys(pacing).length ? { pacing } : {}),
    ...(imagery.length ? { imagery: { searchHints: imagery } } : {}),
  };
  return {
    id: input.id,
    styleFile,
    guide: draftGuide(input, parentId, matchedLayouts, unmatchedLayouts, notes),
    files,
    captionPreset,
    matchedLayouts,
    unmatchedLayouts,
    drivers,
    notes,
  };
}

/** `guide.md`: data about the reference (sections with their own headings, so the parent's stay). */
function draftGuide(
  input: MapInput,
  parentId: string,
  matched: DraftStyle['matchedLayouts'],
  unmatched: DraftStyle['unmatchedLayouts'],
  notes: string[],
): string {
  const m = input.measurements;
  const d = input.description;
  const cs = m.captions.summary;
  const lines = [
    `# ${plainText(input.name, 100) || input.id}`,
    '',
    `A draft extracted from a reference video. It re-skins ${parentId}; the sections below describe the reference and add to the ${parentId} guide.`,
    '',
    '## Reference look (extracted)',
    '',
  ];
  if (d) {
    lines.push(`- Summary: ${plainText(d.summary, 800)}`);
    lines.push(
      `- Motion: entrance ${d.motion.entrance}, frame hold ${String(d.motion.frameHold)}${d.motion.cameraMoves.length ? `, camera moves: ${d.motion.cameraMoves.map((c) => plainText(c, 60)).join(', ')}` : ''}.`,
    );
    if (d.motion.notes) lines.push(`- Motion notes: ${plainText(d.motion.notes, 400)}`);
    lines.push(
      `- Texture: ${d.texture.paper ? 'paper' : 'no paper'}, grain ${String(r2(d.texture.grain))}${d.texture.film ? ', film look' : ''}.`,
    );
  } else lines.push('- No vision description was made; see the measurements below.');
  lines.push(
    `- Palette (largest first): ${m.palette
      .slice(0, 8)
      .map((c) => `${c.hex} ${String(Math.round(c.share * 100))} %`)
      .join(', ')}.`,
  );
  lines.push('', '## Pacing (extracted)', '');
  lines.push(
    `- ${String(m.shotStats.count)} shots in ${String(Math.round(m.durationMs / 100) / 10)} s: a new shot about every ${String(Math.round(m.shotStats.meanMs / 100) / 10)} s (median ${String(Math.round(m.shotStats.medianMs / 100) / 10)} s). Keep beats near that length.`,
  );
  if (m.speakerRatio !== null)
    lines.push(
      `- A speaker is on screen ${String(Math.round(m.speakerRatio * 100))} % of the time.`,
    );
  lines.push('', '## Captions (extracted)', '');
  if (cs.detected) {
    lines.push(
      `- About ${String(cs.wordsPerCaption)} words per caption (set the sequence caption length to match), ${cs.case === 'asis' ? 'mixed case' : `${cs.case} case`}, centred at ${String(Math.round(cs.yPct))} % of the height${cs.revealShare >= 0.5 ? ', revealed word by word' : ''}.`,
    );
    if (d?.captions.emphasis) lines.push(`- Emphasis: ${plainText(d.captions.emphasis, 200)}`);
  } else lines.push('- Caption style not detected; the parent caption preset is kept.');
  if (matched.length || unmatched.length) {
    lines.push('', '## Layouts (extracted)', '');
    for (const l of matched) lines.push(`- ${l.name}: use ${l.template}.`);
    for (const l of unmatched)
      lines.push(`- ${l.name}: no matching template (listed, not built). ${l.description}`);
  }
  lines.push(
    '',
    '## Limits (extracted)',
    '',
    '- The draft approximates the reference look; it copies no footage, images or brand marks.',
    '- Fonts are the closest free fonts; lettering differs when the reference uses a commercial typeface.',
    '- Layouts no template matches are listed, not built.',
  );
  for (const n of notes) lines.push(`- ${plainText(n, 300)}`);
  return `${lines.join('\n')}\n`;
}
