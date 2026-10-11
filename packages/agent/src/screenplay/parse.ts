// Screenplay parser (agent spec "Screenplay match" step 1): a screenplay text (fountain, or plain
// text and markdown with the same scene-heading rule) becomes scenes with a heading, a description
// (the action lines), the dialogue and an estimated duration. Plain code, no model: the same text
// always gives the same scenes.
export interface DialogueLine {
  character: string;
  text: string;
}

export interface Scene {
  /** 1-based, in screenplay order. */
  index: number;
  heading: string;
  /** Action lines, joined with a space. */
  description: string;
  dialogue: DialogueLine[];
  estimatedMs: number;
}

/** Reading speed used for the estimate: dialogue 2.5 words/s, action 3 words/s (a rough film rule). */
export const DIALOGUE_WPS = 2.5;
export const ACTION_WPS = 3;
export const MIN_SCENE_MS = 2000;
export const MAX_SCENE_MS = 20_000;

const HEADING = /^(?:\.(?!\.)|(?:INT|EXT|EST|INT\.?\/EXT|EXT\.?\/INT|I\/E)(?:\.|\s))\s*\S/i;
const SCENE_WORD = /^SCENE\s+\d+\b/i;

const words = (s: string) => s.split(/\s+/).filter((w) => w !== '').length;

/** Milliseconds a scene runs, from its words (rounded to 100 ms, kept between 2 and 20 s). */
export function estimateMs(description: string, dialogue: readonly DialogueLine[]): number {
  const sec =
    words(description) / ACTION_WPS +
    dialogue.reduce((n, d) => n + words(d.text), 0) / DIALOGUE_WPS;
  const ms = Math.round((sec * 1000) / 100) * 100;
  return Math.min(MAX_SCENE_MS, Math.max(MIN_SCENE_MS, ms));
}

/** Boneyard, notes and the formatting marks a heading or line may carry. */
function strip(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\[\[[\s\S]*?\]\]/g, '');
}

function headingText(line: string): string {
  const t = line.replace(/^#{1,6}\s*/, '').trim();
  return t.startsWith('.') && !t.startsWith('..') ? t.slice(1).trim() : t;
}

const isHeading = (line: string): boolean => {
  const t = line.replace(/^#{1,6}\s*/, '').trim();
  return HEADING.test(t) || SCENE_WORD.test(t);
};

/** All-caps line (a character cue), optionally with an extension such as `(V.O.)` or `^`. */
function cue(line: string): string | undefined {
  const t = line.trim().replace(/\^$/, '').trim();
  if (t.startsWith('@'))
    return (
      t
        .slice(1)
        .replace(/\s*\(.*\)\s*$/, '')
        .trim() || undefined
    );
  const name = t.replace(/\s*\([^)]*\)\s*$/, '');
  if (name === '' || /[a-z]/.test(name) || !/[A-Z]/.test(name) || name.length > 40)
    return undefined;
  if (/(?:TO:|IN:|OUT\.?)$/.test(name) || name.startsWith('>')) return undefined;
  return name;
}

/** Parses a screenplay text. Text before the first scene heading (title page) is ignored. */
export function parseScreenplay(text: string): Scene[] {
  const lines = strip(text).split('\n');
  const scenes: Scene[] = [];
  let cur: { heading: string; action: string[]; dialogue: DialogueLine[] } | undefined;
  let speaker: string | undefined;
  const close = () => {
    if (!cur) return;
    const description = cur.action.join(' ').replace(/\s+/g, ' ').trim();
    scenes.push({
      index: scenes.length + 1,
      heading: cur.heading,
      description,
      dialogue: cur.dialogue,
      estimatedMs: estimateMs(description, cur.dialogue),
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const before = i === 0 || lines[i - 1]!.trim() === '';
    if (line === '') {
      speaker = undefined;
      continue;
    }
    if (isHeading(line) && (before || !cur)) {
      close();
      cur = { heading: headingText(line), action: [], dialogue: [] };
      speaker = undefined;
      continue;
    }
    if (!cur) continue; // title page, synopsis before the first scene
    if (/^[#=~]/.test(line) && !isHeading(line)) continue; // sections, synopses, lyrics marks
    if (speaker !== undefined) {
      if (/^\(.*\)$/.test(line)) continue; // parenthetical
      cur.dialogue.push({ character: speaker, text: line });
      continue;
    }
    const next = lines[i + 1]?.trim() ?? '';
    const who = before && next !== '' ? cue(line) : undefined;
    if (who !== undefined) {
      speaker = who;
      continue;
    }
    if (/^(?:>|[A-Z .]+TO:$)/.test(line)) continue; // transitions
    cur.action.push(line.replace(/^!/, ''));
  }
  close();
  return scenes;
}
