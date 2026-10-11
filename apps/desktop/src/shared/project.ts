// Project shapes the renderer reads (engine spec "Data model", frozen in phase 02, D-28). Kept
// structural here because the renderer never imports the engine (R1); the engine's zod schema is the
// source of truth, and the engine host validates every op.

export interface Fps {
  num: number;
  den: number;
}

export type MediaKind = 'video' | 'audio' | 'image' | 'document';

export interface MediaItem {
  id: string;
  kind: MediaKind;
  path: string;
  proxyPath?: string;
  audioPath?: string;
  thumbsPath?: string;
  peaksPath?: string;
  textPath?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  fps?: Fps;
  vfr?: boolean;
  cfrPath?: string;
  loudness?: { integratedLufs: number; truePeakDb: number };
  shotsPath?: string;
  origin: { type: 'url' | 'upload' | 'archive' | 'generated'; url?: string; license?: string };
  transcriptPath?: string;
  transcriptRev?: string;
  facetrackPath?: string;
  tags: string[];
  description?: string;
}

export interface Keyframe {
  atMs: number;
  x: number;
  y: number;
  scale: number;
}

export type FrameMode = 'cover' | 'contain' | 'facetrack' | 'auto' | 'manual';
export type Stability = 'locked' | 'smooth' | 'follow';
export type TrackSpeed = 'slow' | 'normal' | 'fast';
export type Denoise = 'off' | 'light' | 'strong';

export interface Frame {
  mode: FrameMode;
  x?: number;
  y?: number;
  scale?: number;
  faceIndex?: number;
  stability?: Stability;
  trackSpeed?: TrackSpeed;
  keyframes?: Keyframe[];
}

export interface Motion {
  type: 'none' | 'push-in' | 'pan';
  amount: number;
}

export interface TransitionIn {
  template: string;
  durationMs: number;
}

interface ItemBase {
  id: string;
  startMs: number;
  durationMs: number;
  linkId?: string;
  transitionIn?: TransitionIn;
}

export interface MediaClip extends ItemBase {
  type: 'media';
  mediaId: string;
  inMs: number;
  frame?: Frame;
  motion?: Motion;
  volume?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  denoise?: Denoise;
}

export interface SceneClip extends ItemBase {
  type: 'scene';
  template: string;
  templateVersion: string;
  variables: Record<string, unknown>;
  sfxOff?: string[];
}

export type Item = MediaClip | SceneClip;

export interface Track {
  id: string;
  name?: string;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  syncLock: boolean;
  /** Audio tracks only: lowered under the speech tracks in the mix (plan 14f). */
  duck?: boolean;
  items: Item[];
}

export interface CaptionOverride {
  wordKey: string;
  text?: string | null;
  breakAfter?: boolean;
  startMs?: number;
  endMs?: number;
  emphasis?: boolean;
}

export interface CaptionTrack {
  enabled: boolean;
  sourceTrackIds: string[];
  preset: string;
  maxWords: number;
  maxLines: number;
  maxCharsPerLine: number;
  gapFillMs: number;
  autoEmphasis?: boolean;
  position: { yPct: number };
  overrides: CaptionOverride[];
}

export interface Canvas {
  width: number;
  height: number;
  fps: Fps;
}

export interface Sequence {
  id: string;
  name: string;
  canvas: Canvas;
  styleId: string;
  videoTracks: Track[];
  audioTracks: Track[];
  captions: CaptionTrack | null;
  sfx: boolean;
  overlays?: string[];
  sourceRange?: { mediaId: string; inMs: number; outMs: number };
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  version: number;
  media: MediaItem[];
  sequences: Sequence[];
  meta: { createdAt: string; updatedAt: string; sourceUrls: string[] };
}

/** Engine change record (spec "Change records"): one entity before and after. */
export interface Change {
  key: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export type Actor = 'user' | 'agent' | 'cli' | 'external';

/** `project.changed` payload. */
export interface ProjectChanged {
  projectId: string;
  version: number;
  actor: Actor;
  runId?: string;
  op?: string;
  changes: Change[];
}

/** `captions.get` result (engine `CaptionChunk`). */
export interface CaptionWord {
  key: string;
  text: string;
  startMs: number;
  endMs: number;
  emphasis: boolean;
}
export interface CaptionChunk {
  startMs: number;
  endMs: number;
  lines: { words: CaptionWord[] }[];
}

/** `preview.updated` payload (R2, frozen in 10a). */
export interface PreviewPatch {
  /** Scene instance id (the item id). */
  id: string;
  /** Seconds on the sequence clock. */
  start: number;
  duration: number;
  /** Inner HTML of the instance's `<template>`. */
  html: string;
}
export type PreviewUpdated =
  | {
      projectId: string;
      sequenceId: string;
      version: number;
      kind: 'patch';
      patches: PreviewPatch[];
    }
  | { projectId: string; sequenceId: string; version: number; kind: 'reload'; url: string };

/** `styles.list` row (engine `StyleSummary`, structural subset). */
export interface StyleSummaryData {
  id: string;
  name: string;
  description?: string;
  status?: string;
  previews?: string[];
}

export type SlotKind = 'image' | 'cutout' | 'video' | 'geo' | 'template';

/** A template of a resolved style (styles spec `template.json` + registry fields, structural subset). */
export interface TemplateData {
  id: string;
  styleId: string;
  name: string;
  version: string;
  kind: 'scene' | 'transition';
  description: string;
  durationMs: { min: number; default: number; max: number };
  variables: JsonSchema;
  /** JSON-Pointer-like path (`photo`, `items/*\/media`, `panels/*`) → slot kind. */
  slots: Record<string, SlotKind>;
  sfxCues?: { name: string; atMs: number | 'entrance'; sfx: string; type: string }[];
}

/** `styles.get` result (engine `ResolvedStyle`, structural subset). */
export interface ResolvedStyleData {
  id: string;
  chain: string[];
  style: { id: string; name: string; captions?: { default?: string; presets?: string[] } };
  templates: Record<string, TemplateData>;
  captionPresets: Record<string, { id: string; styleId: string; name?: string }>;
  overlays: { name: string; default: boolean; styleId: string }[];
  previews: string[];
}

/** The part of JSON Schema the inspector form understands (styles spec "Template variables"). */
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}
