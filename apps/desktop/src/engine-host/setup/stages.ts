// Which engine stages need which components. A missing component disables only the stages listed for it
// (app spec "First-run setup": the editor opens before setup finishes, dependent stages disabled and labelled).
// Keys are the engine's job kinds (`jobs.start(kind)`, engine 05) plus two ingest sub-stages the UI
// offers separately: `ingest.url` (links) and `ingest.document` (PDF/text, Python only).

export const STAGE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  ingest: ['ffmpeg'],
  'ingest.url': ['ffmpeg', 'yt-dlp', 'deno'],
  'ingest.document': ['python-env'],
  shots: ['ffmpeg'],
  transcribe: ['ffmpeg', 'python-env'],
  facetrack: ['ffmpeg', 'python-env'],
  'assets.fetch': ['ffmpeg'],
  'assets.cutout': ['ffmpeg', 'python-env'],
  quickClips: ['ffmpeg', 'python-env'],
  audioQa: ['ffmpeg', 'python-env'],
  frames: ['ffmpeg', 'chrome'],
  render: ['ffmpeg', 'chrome'],
  exportTimeline: ['ffmpeg', 'chrome', 'python-env'],
};

export interface StateLike {
  id: string;
  state: string;
}

/** stage -> the component ids that are not ready and block it; stages with nothing blocking are absent. */
export function disabledStages(components: readonly StateLike[]): Record<string, string[]> {
  const notReady = new Set(components.filter((c) => c.state !== 'ready').map((c) => c.id));
  const out: Record<string, string[]> = {};
  for (const [stage, needs] of Object.entries(STAGE_REQUIREMENTS)) {
    const blockers = needs.filter((id) => notReady.has(id));
    if (blockers.length > 0) out[stage] = blockers;
  }
  return out;
}
