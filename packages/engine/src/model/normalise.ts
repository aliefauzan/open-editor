// Project <-> entity map (engine spec "Change records"; plan D-15, D-18).
// Keys: project, media:<id>, sequence:<seqId>, track:<seqId>/<trackId>, item:<seqId>/<itemId>,
// captions:<seqId>, captionOverride:<seqId>/<wordKey>.
import type {
  CaptionOverride,
  CaptionTrack,
  Item,
  MediaItem,
  Project,
  Sequence,
  Track,
} from './schema.ts';

export type Entity = Record<string, unknown>;
export type EntityMap = Map<string, Entity>;

/** Fields of a project that are not entities: written by the store on every write. */
export interface ProjectFrame {
  schemaVersion: number;
  version: number;
  updatedAt: string;
}

export function projectFrame(p: Project): ProjectFrame {
  return { schemaVersion: p.schemaVersion, version: p.version, updatedAt: p.meta.updatedAt };
}

const clone = <T>(v: T): T => structuredClone(v);

export function compareWordKeys(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byStart = (a: Item, b: Item) =>
  a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function normalise(p: Project): EntityMap {
  const m: EntityMap = new Map();
  m.set('project', {
    id: p.id,
    name: p.name,
    meta: { createdAt: p.meta.createdAt, sourceUrls: clone(p.meta.sourceUrls) },
  });
  for (const media of p.media) m.set(`media:${media.id}`, clone(media));
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
      for (const o of overrides) m.set(`captionOverride:${s.id}/${o.wordKey}`, clone(o));
    }
  }
  return m;
}

function splitKey(key: string): { type: string; rest: string } {
  const i = key.indexOf(':');
  return i < 0 ? { type: key, rest: '' } : { type: key.slice(0, i), rest: key.slice(i + 1) };
}

/** Split `<seqId>/<sub>` at the first slash (wordKeys contain no slash; seq ids neither). */
export function splitSeqKey(rest: string): { seqId: string; sub: string } {
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
    switch (type) {
      case 'project':
        break;
      case 'media':
        media.push(v as unknown as MediaItem);
        break;
      case 'sequence':
        seqs.set(rest, v);
        break;
      case 'track': {
        const { seqId, sub } = splitSeqKey(rest);
        bucket(tracks, seqId, () => new Map()).set(sub, v);
        break;
      }
      case 'item': {
        const { seqId } = splitSeqKey(rest);
        const { trackId, ...item } = v as Entity & { trackId: string };
        bucket(
          bucket(items, seqId, () => new Map()),
          trackId,
          () => [],
        ).push(item as unknown as Item);
        break;
      }
      case 'captions':
        captions.set(rest, v);
        break;
      case 'captionOverride': {
        const { seqId } = splitSeqKey(rest);
        bucket(overrides, seqId, () => []).push(v as unknown as CaptionOverride);
        break;
      }
      default:
        throw new Error(`unknown entity key ${key}`);
    }
  }
  const sequences: Sequence[] = [];
  for (const [seqId, s] of seqs) {
    const { videoTrackIds, audioTrackIds, ...fields } = s as Entity & {
      videoTrackIds: string[];
      audioTrackIds: string[];
    };
    const build = (tid: string): Track => {
      const t = tracks.get(seqId)?.get(tid);
      if (!t) throw new Error(`sequence ${seqId} lists missing track ${tid}`);
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
      videoTracks: videoTrackIds.map(build) as Sequence['videoTracks'],
      audioTracks: audioTrackIds.map(build) as Sequence['audioTracks'],
      captions: caps,
    });
  }
  return {
    schemaVersion: frame.schemaVersion as Project['schemaVersion'],
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

/** The canonical order of a project (what denormalise produces). */
export function canonical(p: Project): Project {
  return denormalise(normalise(p), projectFrame(p));
}
