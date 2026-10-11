// The bundled free-font catalogue for styles Part C (styles spec "Map"; plan phase 15): about 40
// OFL font families from the pinned Google Fonts commit, with a classification and tags each, in
// `data/fonts/` (packaged: `<resources>/engine-data/fonts/`). An extracted style gets the closest
// font per role, copied into its own `assets/fonts/` with the licence text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { dataDir } from '../../resources.ts';

export const FONT_CLASSES = ['serif', 'sans', 'slab', 'mono', 'script'] as const;
export type FontClass = (typeof FONT_CLASSES)[number];

const FontEntrySchema = z.strictObject({
  family: z.string().min(1).max(100),
  file: z.string().regex(/^[A-Za-z0-9-]+\.ttf$/),
  weights: z.strictObject({ min: z.int().min(1).max(1000), max: z.int().min(1).max(1000) }),
  classification: z.enum(FONT_CLASSES),
  tags: z.array(z.string().regex(/^[a-z-]+$/)),
  licence: z.literal('OFL-1.1'),
  licenceFile: z.string().regex(/^OFL-[a-z0-9]+\.txt$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type FontEntry = z.infer<typeof FontEntrySchema>;

const CatalogueSchema = z.strictObject({
  source: z.string(),
  commit: z.string(),
  fonts: z.array(FontEntrySchema).min(1),
});

export interface FontCatalogue {
  dir: string;
  fonts: FontEntry[];
}

/** Reads `catalogue.json` (default folder: `<engine data>/fonts`). */
export function loadFontCatalogue(dir: string = join(dataDir(), 'fonts')): FontCatalogue {
  const c = CatalogueSchema.parse(JSON.parse(readFileSync(join(dir, 'catalogue.json'), 'utf8')));
  return { dir, fonts: c.fonts };
}

export interface FontWish {
  classification: FontClass;
  /** CSS weight 100–1000. */
  weight: number;
  tags?: readonly string[];
}

export interface FontPick {
  entry: FontEntry;
  /** The weight to use: the wish clamped into the file's range. */
  weight: number;
  score: number;
}

/** Near classes: a slab is close to a serif, a mono to a slab-like typewriter. */
const NEAR: Partial<Record<FontClass, FontClass[]>> = {
  serif: ['slab'],
  slab: ['serif'],
  mono: ['slab'],
};

function score(e: FontEntry, w: FontWish): number {
  let s = 0;
  if (e.classification === w.classification) s += 10;
  else if (NEAR[w.classification]?.includes(e.classification)) s += 4;
  for (const t of w.tags ?? []) if (e.tags.includes(t.toLowerCase())) s += 5; // a named look (condensed, didone, …) outweighs the exact weight
  const inRange = w.weight >= e.weights.min && w.weight <= e.weights.max;
  const gap = inRange
    ? 0
    : Math.min(Math.abs(w.weight - e.weights.min), Math.abs(w.weight - e.weights.max));
  s += inRange ? 3 : -gap / 100;
  return s;
}

/** The closest catalogue font for a wish; ties keep catalogue order (deterministic). */
export function closestFont(cat: FontCatalogue, wish: FontWish): FontPick {
  let best: FontPick | undefined;
  for (const entry of cat.fonts) {
    const s = score(entry, wish);
    if (!best || s > best.score) {
      const weight = Math.round(
        Math.min(Math.max(wish.weight, entry.weights.min), entry.weights.max),
      );
      best = { entry, weight, score: s };
    }
  }
  return best!;
}
