// Project <-> entity map, the renderer's copy of the engine's `model/normalise.ts` (the renderer never
// imports the engine, R1). Change records from `project.changed` and `ops.apply` are applied to the
// map; `denormalise` gives back a project in the engine's canonical order. Keys: project,
// media:<id>, sequence:<seqId>, track:<seqId>/<trackId>, item:<seqId>/<itemId>, captions:<seqId>,
// captionOverride:<seqId>/<wordKey>.
import type {
  CaptionOverride,
  CaptionTrack,
  Change,
  Item,
  MediaItem,
  Project,
  Sequence,
  Track,
} from '../../shared/project.ts';

export type Entity = Record<string, unknown>;
export type EntityMap = Map<string, Entity>;

export interface ProjectFrame {
  schemaVersion: number;
  version: number;
  updatedAt: string;
}

const clone = <T>(v: T): T => structuredClone(v);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byStart = (a: Item, b: Item) =>
  a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const compareWordKeys = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function projectFrame(p: Project): ProjectFrame {
  return { schemaVersion: p.schemaVersion, version: p.version, updatedAt: p.meta.updatedAt };
}

export function normalise(p: Project): EntityMap {
  const m: EntityMap = new Map();
  m.set('project', {
    id: p.id,
    name: p.name,
    meta: { createdAt: p.meta.createdAt, sourceUrls: clone(p.meta.sourceUrls) },
  });
  for (const media of p.media) m.set(`media:${media.id}`, clone(media) as unknown as Entity);
  for (const s of p.sequences) {
    const { videoTracks, audioTracks, captions, ...fields } = s;
    m.set(`sequence:${s.id}`, {
      ...clone(fields),
      videoTrackIds: videoTracks.map((t) => t.id),
      audioTrackIds: audioTracks.map((t) => t.id),
    });
    for (const t of [...videoTracks, ...audioTracks]) {
      const { items, ...tf } = t;
      m.set(`track:${s.id}/${t.id}`, clone(tf));
      for (const it of items) m.set(`item:${s.id}/${it.id}`, { ...clone(it), trackId: t.id });
    }
    if (captions) {
      const { overrides, ...cf } = captions;
      m.set(`captions:${s.id}`, clone(cf));
      for (const o of overrides)
        m.set(`captionOverride:${s.id}/${o.wordKey}`, clone(o) as unknown as Entity);
    }
  }
  return m;
}

/** Applies change records in order (after = null deletes). Returns a new map. */
export function applyChanges(m: EntityMap, changes: readonly Change[]): EntityMap {
  const out = new Map(m);
  for (const c of changes) {
    if (c.after === null) out.delete(c.key);
    else out.set(c.key, clone(c.after));
  }
  return out;
}

/** The changes undone: each record reversed, in reverse order. */
export function invertChanges(changes: readonly Change[]): Change[] {
  return [...changes].reverse().map((c) => ({ key: c.key, before: c.after, after: c.before }));
}

function splitKey(key: string): { type: string; rest: string } {
  const i = key.indexOf(':');
  return i < 0 ? { type: key, rest: '' } : { type: key.slice(0, i), rest: key.slice(i + 1) };
}

function splitSeqKey(rest: string): { seqId: string; sub: string } {
  const i = rest.indexOf('/');
  return { seqId: rest.slice(0, i), sub: rest.slice(i + 1) };
}

export function denormalise(m: EntityMap, frame: ProjectFrame): Project {
  const proj = m.get('project') as
    { id: string; name: string; meta: { createdAt: string; sourceUrls: string[] } } | undefined;
  if (!proj) throw new Error('entity map has no project entity');
  const media: MediaItem[] = [];
  const seqs = new Map<string, Entity>();
  const tracks = new Map<string, Map<string, Entity>>();
  const items = new Map<string, Map<string, Item[]>>();
  const captions = new Map<string, Entity>();
  const overrides = new Map<string, CaptionOverride[]>();
  const bucket = <T>(map: Map<string, T>, k: string, make: () => T): T => {
    let v = map.get(k);
    if (v === undefined) map.set(k, (v = make()));
    return v;
  };
  for (const [key, value] of m) {
    const { type, rest } = splitKey(key);
    const v = clone(value);
    if (type === 'media') media.push(v as unknown as MediaItem);
    else if (type === 'sequence') seqs.set(rest, v);
    else if (type === 'track') {
      const { seqId, sub } = splitSeqKey(rest);
      bucket(tracks, seqId, () => new Map()).set(sub, v);
    } else if (type === 'item') {
      const { seqId } = splitSeqKey(rest);
      const { trackId, ...item } = v as Entity & { trackId: string };
      bucket(
        bucket(items, seqId, () => new Map()),
        trackId,
        () => [],
      ).push(item as unknown as Item);
    } else if (type === 'captions') captions.set(rest, v);
    else if (type === 'captionOverride') {
      const { seqId } = splitSeqKey(rest);
      bucket(overrides, seqId, () => []).push(v as unknown as CaptionOverride);
    }
  }
  const sequences: Sequence[] = [];
  for (const [seqId, s] of seqs) {
    const { videoTrackIds, audioTrackIds, ...fields } = s as Entity & {
      videoTrackIds: string[];
      audioTrackIds: string[];
    };
    const build = (tid: string): Track => {
      const t = tracks.get(seqId)?.get(tid) ?? {
        id: tid,
        locked: false,
        hidden: false,
        muted: false,
        syncLock: true,
      };
      const its = (items.get(seqId)?.get(tid) ?? []).sort(byStart);
      return { ...(t as unknown as Omit<Track, 'items'>), items: its };
    };
    const c = captions.get(seqId);
    const caps: CaptionTrack | null = c
      ? {
          ...(c as unknown as Omit<CaptionTrack, 'overrides'>),
          overrides: (overrides.get(seqId) ?? []).sort((a, b) =>
            compareWordKeys(a.wordKey, b.wordKey),
          ),
        }
      : null;
    sequences.push({
      ...(fields as unknown as Omit<Sequence, 'videoTracks' | 'audioTracks' | 'captions'>),
      videoTracks: videoTrackIds.map(build),
      audioTracks: audioTrackIds.map(build),
      captions: caps,
    });
  }
  return {
    schemaVersion: frame.schemaVersion,
    id: proj.id,
    name: proj.name,
    version: frame.version,
    media: media.sort(byId),
    sequences: sequences.sort(byId),
    meta: {
      createdAt: proj.meta.createdAt,
      updatedAt: frame.updatedAt,
      sourceUrls: proj.meta.sourceUrls,
    },
  };
}

/** Finds an item and its track in a sequence. */
export function findItem(
  s: Sequence,
  itemId: string,
): { item: Item; track: Track; kind: 'video' | 'audio' } | undefined {
  for (const t of s.videoTracks) {
    const item = t.items.find((i) => i.id === itemId);
    if (item) return { item, track: t, kind: 'video' };
  }
  for (const t of s.audioTracks) {
    const item = t.items.find((i) => i.id === itemId);
    if (item) return { item, track: t, kind: 'audio' };
  }
  return undefined;
}

/** Every item of a sequence with its track id. */
export function allItems(s: Sequence): { item: Item; trackId: string }[] {
  return [...s.videoTracks, ...s.audioTracks].flatMap((t) =>
    t.items.map((item) => ({ item, trackId: t.id })),
  );
}
