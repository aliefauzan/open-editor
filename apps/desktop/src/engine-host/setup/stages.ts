// Which engine stages need which components. A missing component disables only the stages listed for it
// (app spec "First-run setup": the editor opens before setup finishes, dependent stages disabled and labelled).
// Stage ids follow the engine spec stage names; phase 09 reconciles this table with the engine registry.

export const STAGE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  'ingest.file': ['ffmpeg'],
  'ingest.url': ['ffmpeg', 'yt-dlp', 'deno'],
  'ingest.document': ['python-env'],
  shots: ['ffmpeg'],
  transcribe: ['ffmpeg', 'python-env'],
  facetrack: ['ffmpeg', 'python-env'],
  'assets.cutout': ['ffmpeg', 'python-env'],
  audioQa: ['ffmpeg', 'python-env'],
  quickClips: ['ffmpeg', 'python-env'],
  render: ['ffmpeg', 'chrome'],
  export: ['ffmpeg', 'chrome'],
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
