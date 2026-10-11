// Styles Part C step 3, "Describe": the structured JSON a vision model returns for a reference video
// (styles spec "Part C"; plan phase 15). The agent package asks for it (`vision` role) and the map
// step reads it. Everything in it is untrusted model output: it only picks among fixed options,
// bounded numbers and short texts, and its texts are escaped wherever they are shown.
import { z } from 'zod';
import { FONT_CLASSES } from './catalogue.ts';

const text = (max: number) => z.string().max(max);
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const FontDescription = z.strictObject({
  classification: z.enum(FONT_CLASSES),
  /** CSS weight. */
  weight: z.int().min(100).max(1000),
  case: z.enum(['upper', 'lower', 'asis']),
  /** Free tags matched against the catalogue tags, e.g. condensed, didone, geometric, typewriter. */
  tags: z.array(text(40)).max(8),
});

export const StyleDescriptionSchema = z.strictObject({
  /** One paragraph on the look, for the guide. */
  summary: text(800),
  fonts: z.strictObject({
    display: FontDescription,
    body: FontDescription,
    caption: FontDescription,
  }),
  captions: z.strictObject({
    /** Words sit on a filled box or plate. */
    boxed: z.boolean(),
    textColor: hexColor.nullable(),
    boxColor: hexColor.nullable(),
    /** Words appear one at a time. */
    wordByWord: z.boolean(),
    emphasis: text(200),
  }),
  motion: z.strictObject({
    /** 1 = smooth, 2–3 = held frames (stop-motion feel). */
    frameHold: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    entrance: z.enum(['pop', 'fade', 'slide', 'none']),
    cameraMoves: z.array(text(60)).max(8),
    notes: text(400),
  }),
  texture: z.strictObject({
    paper: z.boolean(),
    grain: z.number().min(0).max(1),
    film: z.boolean(),
  }),
  layouts: z
    .array(
      z.strictObject({
        name: text(80),
        description: text(300),
        /** A template id the layout resembles (`<style>/<template>`), or null. */
        closestTemplate: text(100).nullable(),
      }),
    )
    .max(12),
  /** Image search hints (archive queries). */
  imagery: z.array(text(80)).max(8),
});
export type StyleDescription = z.infer<typeof StyleDescriptionSchema>;
