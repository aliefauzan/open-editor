// Optimistic local changes (app spec "Live updates and editing flow" step 1): the store shows an op at
// once, before the engine answers. Only ops whose result is easy to predict get a local change; the
// engine result (its change records) always replaces it. Other ops simply wait for the engine.
import type { Change } from '../../shared/project.ts';
import type { Entity, EntityMap } from './entities.ts';

export interface OpCall {
  op: string;
  args: Record<string, unknown>;
}

type ItemEntity = Entity & {
  id: string;
  trackId: string;
  startMs: number;
  durationMs: number;
  inMs?: number;
  speed?: number;
  linkId?: string;
};

const SKIP = Symbol('skip');

/** Sets or (for null) deletes fields of an entity copy. */
function patch(e: Entity, fields: Record<string, unknown>): Entity {
  const out: Entity = structuredClone(e);
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === SKIP) continue;
    if (v === null) delete out[k];
    else out[k] = structuredClone(v);
  }
  return out;
}

const omit = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function items(m: EntityMap, seqId: string): [string, ItemEntity][] {
  const prefix = `item:${seqId}/`;
  return [...m].filter(([k]) => k.startsWith(prefix)) as [string, ItemEntity][];
}

/** The item and, unless `unlinked`, its linked partners. */
function withLinked(m: EntityMap, seqId: string, itemId: string, unlinked: unknown) {
  const all = items(m, seqId);
  const self = all.find(([, e]) => e.id === itemId);
  if (!self) return [];
  if (unlinked === true || self[1].linkId === undefined) return [self];
  return all.filter(([, e]) => e.id === itemId || e.linkId === self[1].linkId);
}

function change(m: EntityMap, key: string, after: Entity | null): Change {
  return { key, before: m.get(key) ?? null, after };
}

/** Local change records for `call`, or `[]` when the op waits for the engine. */
export function optimisticChanges(m: EntityMap, call: OpCall): Change[] {
  const a = call.args;
  const seqId = typeof a['sequenceId'] === 'string' ? a['sequenceId'] : '';
  switch (call.op) {
    case 'moveItem': {
      const group = withLinked(m, seqId, String(a['itemId']), a['unlinked']);
      const self = group.find(([, e]) => e.id === a['itemId']);
      if (!self) return [];
      const delta = typeof a['startMs'] === 'number' ? a['startMs'] - self[1].startMs : 0;
      return group.map(([k, e]) =>
        change(
          m,
          k,
          patch(e, {
            startMs: e.startMs + delta,
            trackId: e.id === a['itemId'] && typeof a['trackId'] === 'string' ? a['trackId'] : SKIP,
          }),
        ),
      );
    }
    case 'trimItem': {
      const group = withLinked(m, seqId, String(a['itemId']), a['unlinked']);
      const self = group.find(([, e]) => e.id === a['itemId']);
      if (!self || typeof a['toMs'] !== 'number') return [];
      const to = a['toMs'];
      if (a['edge'] === 'start') {
        const delta = to - self[1].startMs;
        return group.map(([k, e]) =>
          change(
            m,
            k,
            patch(e, {
              startMs: e.startMs + delta,
              durationMs: e.durationMs - delta,
              // source moves by the trimmed time × speed (plan D-62)
              inMs: e.inMs === undefined ? SKIP : e.inMs + Math.round(delta * (e.speed ?? 1)),
            }),
          ),
        );
      }
      const delta = to - (self[1].startMs + self[1].durationMs);
      return group.map(([k, e]) => change(m, k, patch(e, { durationMs: e.durationMs + delta })));
    }
    case 'updateClip':
    case 'updateScene': {
      const key = `item:${seqId}/${String(a['itemId'])}`;
      const e = m.get(key);
      if (!e) return [];
      return [change(m, key, patch(e, omit(a, ['sequenceId', 'itemId'])))];
    }
    case 'setTransition': {
      const key = `item:${seqId}/${String(a['itemId'])}`;
      const e = m.get(key);
      if (!e) return [];
      return [change(m, key, patch(e, { transitionIn: a['transition'] }))];
    }
    case 'updateTrack': {
      const key = `track:${seqId}/${String(a['trackId'])}`;
      const e = m.get(key);
      if (!e) return [];
      return [change(m, key, patch(e, omit(a, ['sequenceId', 'trackId'])))];
    }
    case 'setCaptions': {
      const key = `captions:${seqId}`;
      const e = m.get(key);
      if (!e) return [];
      return [change(m, key, patch(e, omit(a, ['sequenceId', 'overrides', 'resetWords'])))];
    }
    case 'updateSequence': {
      const key = `sequence:${seqId}`;
      const e = m.get(key);
      if (!e) return [];
      return [change(m, key, patch(e, omit(a, ['sequenceId', 'canvas'])))];
    }
    default:
      return [];
  }
}
