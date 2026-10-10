// Rules enforced after every op (engine spec "Rules enforced by every operation").
// Only entities the op changed are checked, so an op never fails on an unrelated old item.
import type { Change } from '../model/diff.ts';
import { splitSeqKey } from '../model/normalise.ts';
import { parseProject, type Item, type Project, type Sequence } from '../model/schema.ts';
import { endOf, fail, isVideoTrack, onGrid, overlapError, sourceFps, tracksOf } from './core.ts';
import type { TemplateLookup } from './templates.ts';

function trackOf(p: Project, seqId: string, trackId: string) {
  const s = p.sequences.find((x) => x.id === seqId);
  return s ? { s, t: tracksOf(s).find((x) => x.id === trackId) } : undefined;
}

function checkLocked(before: Project, seqId: string, trackId: string, itemId: string): void {
  const t = trackOf(before, seqId, trackId)?.t;
  if (t?.locked) {
    fail(
      'TRACK_LOCKED',
      `Track ${trackId} is locked`,
      `Unlock ${trackId} first (updateTrack locked: false)`,
      {
        trackId,
        itemId,
      },
    );
  }
}

function checkItem(
  p: Project,
  s: Sequence,
  trackId: string,
  it: Item,
  templates: TemplateLookup,
): void {
  const fps = s.canvas.fps;
  if (!onGrid(it.startMs, fps) || !onGrid(endOf(it), fps)) {
    fail(
      'VALIDATION',
      `Item ${it.id} is off the frame grid`,
      'Times must lie on the sequence frame grid',
      {
        itemId: it.id,
      },
    );
  }
  const video = isVideoTrack(trackId);
  if (it.type === 'scene') {
    if (!video)
      fail(
        'TRACK_KIND',
        `Scene ${it.id} cannot go on audio track ${trackId}`,
        'Put scenes on a video track',
        { itemId: it.id, trackId },
      );
    const t = templates.get(it.template);
    if (t && (it.durationMs < t.durationMs.min || it.durationMs > t.durationMs.max)) {
      fail(
        'DURATION_BOUNDS',
        `Scene ${it.id} lasts ${it.durationMs} ms; ${it.template} allows ${t.durationMs.min}–${t.durationMs.max} ms`,
        'Pick a duration inside the template bounds',
        { itemId: it.id },
      );
    }
    return;
  }
  const media = p.media.find((m) => m.id === it.mediaId);
  if (!media)
    fail('NOT_FOUND', `Media ${it.mediaId} of item ${it.id} not found`, 'Add the media first', {
      itemId: it.id,
    });
  const ok = video
    ? media.kind === 'video' || media.kind === 'image'
    : media.kind === 'audio' || (media.kind === 'video' && media.hasAudio === true);
  if (!ok) {
    fail(
      'TRACK_KIND',
      `${media.kind} media ${media.id} cannot go on ${video ? 'video' : 'audio'} track ${trackId}`,
      'Video tracks take scenes, video and images; audio tracks take audio and video with sound',
      { itemId: it.id, trackId },
    );
  }
  if (media.kind !== 'image' && !onGrid(it.inMs, sourceFps(p, s, it))) {
    fail(
      'VALIDATION',
      `Item ${it.id} inMs is off the source frame grid`,
      'Snap inMs to the source grid',
      { itemId: it.id },
    );
  }
  if ((media.kind === 'video' || media.kind === 'audio') && media.durationMs !== undefined) {
    if (it.inMs + it.durationMs > media.durationMs) {
      fail(
        'MEDIA_BOUNDS',
        `Item ${it.id} runs past the end of ${media.id} (${it.inMs + it.durationMs} > ${media.durationMs} ms)`,
        'Shorten the clip or start earlier in the source',
        { itemId: it.id, mediaId: media.id },
      );
    }
  }
}

export function checkInvariants(
  before: Project,
  after: Project,
  changes: Change[],
  templates: TemplateLookup,
): Project {
  const parsed = parseProject(after);
  const tracksToCheck = new Set<string>();
  for (const c of changes) {
    const i = c.key.indexOf(':');
    const type = c.key.slice(0, i);
    const rest = c.key.slice(i + 1);
    if (type === 'item') {
      const { seqId, sub } = splitSeqKey(rest);
      const b = c.before as (Item & { trackId: string }) | null;
      const a = c.after as (Item & { trackId: string }) | null;
      if (b) checkLocked(before, seqId, b.trackId, sub);
      if (a) {
        checkLocked(before, seqId, a.trackId, sub);
        const s = parsed.sequences.find((x) => x.id === seqId);
        if (s) {
          const { trackId, ...item } = a;
          checkItem(parsed, s, trackId, item as Item, templates);
          tracksToCheck.add(`${seqId}/${trackId}`);
        }
      }
    } else if (type === 'captions' && c.after) {
      const s = parsed.sequences.find((x) => x.id === rest);
      const ids = (c.after['sourceTrackIds'] ?? []) as string[];
      for (const tid of ids) {
        if (!s?.audioTracks.some((t) => t.id === tid)) {
          fail(
            'NOT_FOUND',
            `Caption source track ${tid} not found`,
            'Use audio track ids of the sequence',
            { trackId: tid },
          );
        }
      }
    }
  }
  for (const key of tracksToCheck) {
    const { seqId, sub } = splitSeqKey(key);
    const hit = trackOf(parsed, seqId, sub);
    if (!hit?.t) continue;
    const items = hit.t.items;
    for (let k = 1; k < items.length; k++) {
      const prev = items[k - 1]!;
      const cur = items[k]!;
      if (endOf(prev) > cur.startMs) overlapError(hit.t, prev, cur);
    }
  }
  return parsed;
}
