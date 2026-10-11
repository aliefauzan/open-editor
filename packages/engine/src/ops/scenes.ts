// Scene and transition ops: addScene, updateScene, setTransition (engine spec "Edit operations",
// "Transitions"; plan D-14 sfxOff).
import { z } from 'zod';
import {
  ItemIdSchema,
  SequenceIdSchema,
  TemplateIdSchema,
  TrackIdSchema,
  type Project,
  type SceneClip,
} from '../model/schema.ts';
import { blendHalf } from '../model/fps.ts';
import { endOf, fail, findItem, findSeq, findTrack, snapT, type OpContext } from './core.ts';
import { OnOverlapSchema } from './items.ts';
import { placeItems } from './timeline.ts';
import {
  requireTemplate,
  switchVariables,
  validateVariables,
  type TemplateInfo,
} from './templates.ts';

const Variables = z.record(z.string(), z.unknown());

export const addSceneArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  trackId: TrackIdSchema,
  startMs: z.int().min(0),
  durationMs: z.int().positive().optional(),
  template: TemplateIdSchema,
  variables: Variables,
  sfxOff: z.array(z.string().min(1)).optional(),
  onOverlap: OnOverlapSchema.default('error'),
});

export const updateSceneArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  template: TemplateIdSchema.optional(),
  variables: Variables.optional(),
  sfxOff: z.array(z.string().min(1)).optional(),
});

export const setTransitionArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  itemId: ItemIdSchema,
  transition: z
    .strictObject({ template: TemplateIdSchema, durationMs: z.int().positive() })
    .nullable(),
});

function checkSfxOff(t: TemplateInfo, names: string[]): void {
  const cues = new Set((t.sfxCues ?? []).map((c) => c.name));
  const unknown = names.filter((n) => !cues.has(n));
  if (unknown.length > 0) {
    fail(
      'SFX_UNKNOWN',
      `${t.id} declares no sfx cue ${unknown.join(', ')}`,
      `Use cue names of ${t.id}: ${[...cues].join(', ') || '(none)'}`,
      {
        template: t.id,
        names: unknown,
      },
    );
  }
}

export function addScene(
  p: Project,
  a: z.infer<typeof addSceneArgs>,
  ctx: OpContext,
): { itemIds: string[] } {
  const s = findSeq(p, a.sequenceId);
  const track = findTrack(s, a.trackId);
  const t = requireTemplate(ctx.templates, a.template, 'scene');
  validateVariables(t, a.variables, ctx.templates, p);
  if (a.sfxOff) checkSfxOff(t, a.sfxOff);
  const start = snapT(s, a.startMs);
  const end = snapT(s, start + (a.durationMs ?? t.durationMs.default));
  if (end <= start)
    fail('VALIDATION', 'The scene would be shorter than one frame', 'Pass a longer durationMs');
  const scene: SceneClip = {
    id: ctx.newId('it_'),
    type: 'scene',
    template: t.id,
    templateVersion: t.version,
    startMs: start,
    durationMs: end - start,
    variables: a.variables,
  };
  if (a.sfxOff && a.sfxOff.length > 0) scene.sfxOff = [...new Set(a.sfxOff)];
  placeItems(p, s, [{ track, item: scene }], a.onOverlap, ctx);
  return { itemIds: [scene.id] };
}

export function updateScene(
  p: Project,
  a: z.infer<typeof updateSceneArgs>,
  ctx: OpContext,
): { droppedVariables: string[] } | undefined {
  const s = findSeq(p, a.sequenceId);
  const { item } = findItem(s, a.itemId);
  if (item.type !== 'scene') {
    fail(
      'VALIDATION',
      `Item ${item.id} is a media clip, not a scene`,
      'Use updateClip for media clips',
      { itemId: item.id },
    );
  }
  let report: { droppedVariables: string[] } | undefined;
  let t: TemplateInfo;
  let vars = a.variables ?? item.variables;
  if (a.template !== undefined && a.template !== item.template) {
    const from = requireTemplate(ctx.templates, item.template, 'scene');
    t = requireTemplate(ctx.templates, a.template, 'scene');
    const sw = switchVariables(from, t, vars);
    vars = sw.variables;
    report = { droppedVariables: sw.dropped };
    item.template = t.id;
    item.templateVersion = t.version;
    if (item.sfxOff && a.sfxOff === undefined) {
      const cues = new Set((t.sfxCues ?? []).map((c) => c.name));
      item.sfxOff = item.sfxOff.filter((n) => cues.has(n));
    }
  } else {
    t = requireTemplate(ctx.templates, item.template, 'scene');
  }
  validateVariables(t, vars, ctx.templates, p);
  item.variables = vars;
  if (a.sfxOff !== undefined) {
    checkSfxOff(t, a.sfxOff);
    item.sfxOff = [...new Set(a.sfxOff)];
  }
  if (item.sfxOff?.length === 0) delete item.sfxOff;
  return report;
}

export function setTransition(
  p: Project,
  a: z.infer<typeof setTransitionArgs>,
  ctx: OpContext,
): void {
  const s = findSeq(p, a.sequenceId);
  const { track, item } = findItem(s, a.itemId);
  if (a.transition === null) {
    delete item.transitionIn;
    return;
  }
  const t = requireTemplate(ctx.templates, a.transition.template, 'transition');
  const d = snapT(s, a.transition.durationMs);
  if (d < t.durationMs.min || d > t.durationMs.max || d <= 0) {
    fail(
      'DURATION_BOUNDS',
      `${t.id} allows ${t.durationMs.min}–${t.durationMs.max} ms, got ${d}`,
      'Pick a duration inside the template bounds',
      {
        template: t.id,
      },
    );
  }
  if (t.blendsShots) {
    const { before, after } = blendHalf(item.startMs, d, s.canvas.fps);
    const half = Math.max(before, after);
    const prev = track.items.find((i) => endOf(i) === item.startMs);
    const media = (id: string) => p.media.find((m) => m.id === id);
    const short: string[] = [];
    if (item.type === 'media') {
      const m = media(item.mediaId);
      if (m && m.kind !== 'image' && item.inMs < before) short.push(item.id);
    }
    if (prev?.type === 'media') {
      const m = media(prev.mediaId);
      if (
        m &&
        m.kind !== 'image' &&
        m.durationMs !== undefined &&
        prev.inMs + prev.durationMs + after > m.durationMs
      ) {
        short.push(prev.id);
      }
    }
    if (short.length > 0) {
      fail(
        'NO_HANDLES',
        `${t.id} blends the two shots and needs ${half} ms of source beyond the cut; ${short.join(', ')} has less`,
        'Use a cover-style transition (e.g. a wipe or dip), or trim the clips to leave handles',
        { itemIds: short, template: t.id },
      );
    }
  }
  item.transitionIn = { template: t.id, durationMs: d };
}
