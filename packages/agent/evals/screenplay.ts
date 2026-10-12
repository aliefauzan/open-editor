// Live eval of the screenplay workflow (14b; agent spec "Testing", "Done when" 5): the generated
// screenplay set (scripts/make-screenplay-set.ts) is ingested, each clip gets a transcript seeded from
// its spoken line (the clips' pictures are test patterns, so speech is what a real model has to match
// on, as in the other evals, which seed their analysis files), and the workflow runs with the
// configured role models. It scores the order: scene N must hold the clip that belongs to scene N.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngine, type Engine } from '@vox/engine';
import { makeScreenplaySet, SCENES } from '../../../scripts/make-screenplay-set.ts';
import { runEngineJob } from '../src/tools/jobs.ts';
import { runWorkflow } from '../src/workflows/run-workflow.ts';
import { REPO_ROOT, workflowDeps, type EvalDeps } from './run.ts';
import { scorecard, type Scorecard } from './scorecard.ts';

/** A transcript of `text`, the words spread over the clip (the real file comes from `transcribe`). */
export function seededTranscript(text: string, durationMs: number) {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const start = 200;
  const step = Math.floor((durationMs - 2 * start) / Math.max(words.length, 1));
  return {
    language: 'en',
    words: words.map((w, i) => ({
      text: w,
      startMs: start + i * step,
      endMs: start + (i + 1) * step - 20,
      kind: 'word' as const,
    })),
    speechRegions: [{ startMs: start, endMs: start + words.length * step }],
  };
}

export async function runScreenplay(deps: EvalDeps): Promise<Scorecard> {
  const projectsDir = join(mkdtempSync(join(tmpdir(), 'vox-eval-sp-')), 'Projects');
  const e: Engine =
    deps.engine?.(projectsDir) ??
    openEngine({ projectsDir, stylesDirs: [join(REPO_ROOT, 'styles')] });
  const set = mkdtempSync(join(tmpdir(), 'vox-eval-sp-set-'));
  makeScreenplaySet(set);
  const p = await e.createProject('eval screenplay');
  const job = deps.runJob ?? ((k, a) => runEngineJob(e, k, a));
  const ingest = async (path: string) =>
    (
      (await job('ingest', { projectId: p.id, inputs: [path], actor: 'cli' })) as {
        media: { mediaId: string }[];
      }
    ).media[0]!.mediaId;
  const documentId = await ingest(join(set, 'screenplay.fountain'));
  const dir = join(e.projectsDir, p.id);
  mkdirSync(join(dir, 'transcripts'), { recursive: true });
  const idOf = new Map<string, string>();
  for (const s of SCENES) {
    const mediaId = await ingest(join(set, 'clips', `${s.clip}.mp4`));
    idOf.set(s.clip, mediaId);
    const t = JSON.stringify(seededTranscript(s.say, 3000));
    writeFileSync(join(dir, 'transcripts', `${mediaId}.json`), t);
    await e.applyOp(
      p.id,
      {
        op: 'updateMedia',
        args: {
          mediaId,
          patch: {
            transcriptPath: `transcripts/${mediaId}.json`,
            transcriptRev: createHash('sha256').update(t).digest('hex').slice(0, 16),
          },
        },
      } as never,
      { actor: 'cli' },
    );
  }
  const t0 = Date.now();
  const r = await runWorkflow(workflowDeps(deps, e, []), {
    projectId: p.id,
    workflow: 'screenplay',
    message: 'match each scene of the screenplay to the right clip',
    mode: deps.mode,
    screenplay: documentId,
  });
  const violations: string[] = [];
  const seq = (await e.getProject(p.id)).sequences.find((s) => s.id === r.sequenceIds[0]);
  const items = seq?.videoTracks.find((t) => t.id === 'V1')?.items ?? [];
  if (!seq || items.length !== SCENES.length)
    violations.push(`${String(items.length)} item(s) on V1, expected ${String(SCENES.length)}`);
  SCENES.forEach((s, i) => {
    const it = items[i];
    const want = idOf.get(s.clip);
    const got = it?.type === 'media' ? it.mediaId : it?.type;
    if (got !== want)
      violations.push(
        `scene ${String(i + 1)} (${s.heading}): ${it?.type === 'scene' ? 'a placeholder' : 'the wrong clip'}`,
      );
  });
  if (violations.length > 0 && r.screenplay)
    violations.push(
      `ranking: ${r.screenplay.method}; ${r.screenplay.notes.slice(0, 4).join(' | ')}`,
    );
  return scorecard('screenplay', r, violations, Date.now() - t0);
}
