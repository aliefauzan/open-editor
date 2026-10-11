// The `ingest` source rule (agent spec "Untrusted content and threat model", R4 S20, S35): the
// agent may ingest only a source that appears verbatim in the user's own messages or attachments
// in this conversation; any other source pauses the run (`approval`, kind `source`).

/** Characters that may surround a source in a message (whitespace, quotes, brackets, `<>`). */
const BOUNDARY = /[\s"'`<>()[\]{}]/;

/** True when `source` is one of the user's texts or stands alone (bounded) inside one. */
export function sourceNamedByUser(source: string, userTexts: Iterable<string>): boolean {
  const s = source.trim();
  if (s === '') return false;
  for (const text of userTexts) {
    if (text === s) return true;
    let at = text.indexOf(s);
    while (at !== -1) {
      const before = at === 0 ? '' : (text[at - 1] as string);
      const afterIndex = at + s.length;
      const after = afterIndex >= text.length ? '' : (text[afterIndex] as string);
      // a trailing sentence mark after a link is not part of it ("see https://x/y.")
      const afterOk =
        after === '' ||
        BOUNDARY.test(after) ||
        (/[.,;:!?]/.test(after) &&
          (afterIndex + 1 >= text.length || BOUNDARY.test(text[afterIndex + 1] as string)));
      if ((before === '' || BOUNDARY.test(before)) && afterOk) return true;
      at = text.indexOf(s, at + 1);
    }
  }
  return false;
}

/** The sources of an ingest call that need the user's approval first. */
export function unapprovedSources(
  sources: readonly string[],
  userTexts: Iterable<string>,
  approved: ReadonlySet<string>,
): string[] {
  const texts = [...userTexts];
  return sources.filter((s) => !approved.has(s) && !sourceNamedByUser(s, texts));
}
