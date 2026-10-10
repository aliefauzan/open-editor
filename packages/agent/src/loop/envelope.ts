// Untrusted-content envelope (agent spec "Untrusted content and threat model", R4 S21, S34).
// Text the agent did not write (transcripts, metadata, captions, vision descriptions) is wrapped in
// `<data source="…">…</data>`. Inside, every `<` that starts a `<data` or `</data` sequence is
// escaped, so the payload cannot close the envelope or open a nested one.

// `<`, optional whitespace, optional `/`, optional whitespace, `data` (any case)
// Also looks through control and zero-width characters, and escapes the fullwidth `＜`.
const GAP = '[\\s\\p{Cc}\\p{Cf}]*';
const DATA_TAG_START = new RegExp(`[<＜](?=${GAP}/?${GAP}data)`, 'giu');
const SOURCE = /^[a-z][a-z0-9_.:-]{0,63}$/i;

/** Escape the `<` of every `<data` / `</data` sequence (case-insensitive, whitespace-tolerant). */
export function escapeData(text: string): string {
  return text.replace(DATA_TAG_START, '&lt;');
}

/** Wrap untrusted text. `source` is ours (`transcript`, `caption`, `vision`, …), never untrusted. */
export function wrapData(source: string, text: string): string {
  if (!SOURCE.test(source))
    throw new Error(`invalid data envelope source: ${JSON.stringify(source)}`);
  return `<data source="${source}">\n${escapeData(text)}\n</data>`;
}
