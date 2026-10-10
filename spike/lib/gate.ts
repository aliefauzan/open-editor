/**
 * GATE 1 outcome selection from the pass-bar results (engine spec "Spike", plan D-10 / D-15).
 * Pure, so the rule table is unit-tested.
 */

export interface GateInput {
  /** pass per item 1-9; item 8 is recorded only and never selects an outcome. */
  pass: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 9, boolean>>;
  /** item 4 in the opaque sandbox, and with allow-same-origin when that was measured. */
  item4: { opaque: boolean; sameOrigin?: boolean };
  /** heavy-scene fps margin over 24 fps, percent; null when not measured. */
  marginPct: number | null;
}

export interface GateOutcome {
  allPass: boolean;
  outcomes: string[];
}

/** An item that was not measured counts as failed (D-10). */
const ok = (v: boolean | undefined): boolean => v === true;

export function gateOutcome(g: GateInput): GateOutcome {
  const out: string[] = [];
  const p = g.pass;
  if (!ok(p[1]) || !ok(p[3]) || !ok(p[5])) out.push('hybrid export through the layer renderer');
  if (!ok(p[2])) out.push('re-measure A/V sync with silent picture + ffmpeg-mixed click track');
  if (!ok(p[7])) out.push('per-mechanism alternative (engine spec "Compile")');
  const item4 = g.item4.opaque || g.item4.sameOrigin === true;
  if (!item4 || !ok(p[6])) out.push('app "Preview fallback"');
  else if (!g.item4.opaque) out.push('allow-same-origin sandbox fallback on vox-media://');
  if (!ok(p[9])) out.push('NTSC fallback: integer rates only');
  if (item4 && (g.marginPct === null || g.marginPct < 20)) out.push('pre-render cache (10a)');
  const allPass = out.length === 0;
  return {
    allPass,
    outcomes: allPass ? ['whole-sequence render; NTSC go; no pre-render cache'] : out,
  };
}
