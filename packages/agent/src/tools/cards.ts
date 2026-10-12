// Frame cards as text for the model (plan D-73): `view_frames` and `view_media` send one short block
// per still (Apple Vision labels, on-screen text, faces, saliency, aesthetics) instead of images.
// On-screen text is untrusted, so the blocks travel inside `<data source="framecard">` (S21, S34).
import type { FrameCard } from '@vox/engine';
import { wrapData } from '../loop/envelope.ts';
import type { ToolContext } from './types.ts';

/** Text lines below this Vision confidence are mostly noise (measured, D-73). */
export const CARD_TEXT_MIN_CONFIDENCE = 0.5;
const MAX_TEXT_LINES = 6;
const MAX_LINE_CHARS = 80;
const MAX_FACE_BOXES = 4;

export const CARD_NOTE =
  'Frame cards from Apple Vision: labels with confidence, on-screen text with its vertical span, ' +
  'faces and the salient region as x,y wxh shares of the frame (top-left origin), aesthetics ' +
  '(-1 to 1). For visual judgments (framing, caption look, colour) call again with detail "pixels".';

const n2 = (v: number): string => v.toFixed(2);
const box = (b: { x: number; y: number; w: number; h: number }): string =>
  `${n2(b.x)},${n2(b.y)} ${n2(b.w)}x${n2(b.h)}`;

/** One still's block: a header line (`seqMs 1200`, …) then one line per finding. */
export function cardBlock(header: string, card: FrameCard): string {
  if ('error' in card) return `${header}\ncard: not available (${card.error.code})`;
  const lines = [header];
  lines.push(
    `labels: ${card.labels.map((l) => `${l.label} ${n2(l.confidence)}`).join(', ') || 'none'}`,
  );
  const text = card.text
    .filter((t) => t.confidence >= CARD_TEXT_MIN_CONFIDENCE && /[\p{L}\p{N}]/u.test(t.text))
    .slice(0, MAX_TEXT_LINES)
    .map((t) => {
      const s = t.text.length > MAX_LINE_CHARS ? `${t.text.slice(0, MAX_LINE_CHARS)}…` : t.text;
      return `"${s}" y ${n2(t.box.y)}-${n2(t.box.y + t.box.h)}`;
    });
  lines.push(`text: ${text.join(' | ') || 'none'}`);
  const faces = card.faces.boxes.slice(0, MAX_FACE_BOXES).map(box);
  lines.push(`faces: ${String(card.faces.count)}${faces.length ? ` [${faces.join('; ')}]` : ''}`);
  if (card.saliency) lines.push(`salient: ${box(card.saliency)}`);
  if (card.aesthetics) {
    lines.push(
      `aesthetics: ${n2(card.aesthetics.overall)}${card.aesthetics.utility ? ' (utility image)' : ''}`,
    );
  }
  return lines.join('\n');
}

/**
 * The cards of `paths` as one wrapped text, or null when cards cannot be made here (not macOS, no
 * Python tool, a still outside the project): the caller then uses the pixels path. Cancellation
 * is never swallowed.
 */
export async function presentCards(
  ctx: ToolContext,
  paths: readonly string[],
  headers: readonly string[],
): Promise<string | null> {
  try {
    const cards = await ctx.engine.frameCards(
      ctx.projectId,
      paths,
      ctx.signal ? { signal: ctx.signal } : {},
    );
    return wrapData(
      'framecard',
      cards.map((c, i) => cardBlock(headers[i] ?? `still ${String(i + 1)}`, c)).join('\n\n'),
    );
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return null;
  }
}
