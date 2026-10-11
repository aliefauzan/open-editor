// Sound cue list (engine spec "Sound cues", plan D-14): SFX placed from timeline events, never typed
// by hand. Pure: the caller passes the template lookup.
import { frame, ms } from '../model/fps.ts';
import type { Project, Sequence } from '../model/schema.ts';
import type { SfxCueInfo, TemplateLookup } from '../ops/templates.ts';

export interface Cue {
  atMs: number;
  sfx: string;
  type: SfxCueInfo['type'];
  itemId: string;
  cueName: string;
}

export type CueDropReason = 'spacing' | 'hero-spacing' | 'muted';

export interface CueList {
  cues: Cue[];
  dropped: { cue: Cue; reason: CueDropReason }[];
}

/** A cue closer than this to an earlier kept cue is dropped. */
export const CUE_SPACING_MS = 120;
/** A `hero` cue closer than this to an earlier kept `hero` cue is dropped. */
export const HERO_SPACING_MS = 4000;

interface Candidate {
  cue: Cue;
  muted: boolean;
}

/**
 * The cue list of a sequence. Scene cues sit at the item's start plus the cue offset; transition
 * cues at the cut (the incoming item's start) plus the offset. `'entrance'` is offset 0. Times are
 * snapped to the sequence's frame grid. Hidden tracks contribute no cues.
 */
export function cueList(s: Sequence, templates: TemplateLookup): CueList {
  const fps = s.canvas.fps;
  const snapMs = (t: number) => ms(frame(t, fps), fps);
  const all: Candidate[] = [];
  const add = (
    cues: readonly SfxCueInfo[] | undefined,
    at: number,
    itemId: string,
    off: string[],
  ) => {
    for (const c of cues ?? []) {
      const offset = c.atMs === 'entrance' ? 0 : c.atMs;
      all.push({
        cue: { atMs: snapMs(at + offset), sfx: c.sfx, type: c.type, itemId, cueName: c.name },
        muted: !s.sfx || off.includes(c.name),
      });
    }
  };
  for (const t of s.videoTracks) {
    if (t.hidden) continue;
    for (const it of t.items) {
      const off = it.type === 'scene' ? (it.sfxOff ?? []) : [];
      if (it.type === 'scene') add(templates.get(it.template)?.sfxCues, it.startMs, it.id, off);
      if (it.transitionIn) {
        add(templates.get(it.transitionIn.template)?.sfxCues, it.startMs, it.id, off);
      }
    }
  }
  all.sort(
    (a, b) =>
      a.cue.atMs - b.cue.atMs ||
      (a.cue.itemId < b.cue.itemId ? -1 : a.cue.itemId > b.cue.itemId ? 1 : 0) ||
      (a.cue.cueName < b.cue.cueName ? -1 : a.cue.cueName > b.cue.cueName ? 1 : 0),
  );
  const out: CueList = { cues: [], dropped: [] };
  let last: Cue | undefined;
  let lastHero: Cue | undefined;
  for (const { cue, muted } of all) {
    if (muted) out.dropped.push({ cue, reason: 'muted' });
    else if (last && cue.atMs - last.atMs < CUE_SPACING_MS) {
      out.dropped.push({ cue, reason: 'spacing' });
    } else if (cue.type === 'hero' && lastHero && cue.atMs - lastHero.atMs < HERO_SPACING_MS) {
      out.dropped.push({ cue, reason: 'hero-spacing' });
    } else {
      out.cues.push(cue);
      last = cue;
      if (cue.type === 'hero') lastHero = cue;
    }
  }
  return out;
}

/** `audio/cues.json` content (stable key order, trailing newline). */
export function cuesJson(list: CueList): string {
  return `${JSON.stringify(list, null, 2)}\n`;
}

/** Cue list of a sequence by id (convenience for the API). */
export function sequenceCues(p: Project, sequenceId: string, templates: TemplateLookup): CueList {
  const s = p.sequences.find((x) => x.id === sequenceId);
  return s ? cueList(s, templates) : { cues: [], dropped: [] };
}
