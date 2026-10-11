// The screenplay live eval, run offline with a scripted ranker (14b): clips carry only their seeded
// transcript (no vision model), the ranker matches the spoken line to the scene's dialogue, and the
// scorecard passes with every scene on its own clip; a ranker that always picks the same clip fails it.
import { createRedactor, openEngine } from '@vox/engine';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO_ROOT, type EvalDeps } from '../../evals/run.ts';
import { runScreenplay, seededTranscript } from '../../evals/screenplay.ts';
import { rankerModel } from '../helpers/screenplay.ts';
import { fakeJobs, fakeRender, role } from '../helpers/workflow.ts';

function deps(model: ReturnType<typeof rankerModel>): EvalDeps {
  let engine: ReturnType<typeof fakeRender> | undefined;
  const jobs = fakeJobs(() => engine!);
  return {
    models: { editor: role(model.model) },
    mode: 'tools',
    maxUsdPerRun: 2,
    maxStepsPerRun: 60,
    engine: (projectsDir) =>
      (engine = fakeRender(
        openEngine({
          projectsDir,
          stylesDirs: [join(REPO_ROOT, 'styles')],
          config: async () => ({}),
        }),
      )),
    runJob: jobs.runJob,
    redactor: createRedactor(),
  };
}

describe('screenplay eval (offline)', () => {
  test('a ranker that reads the spoken line passes: every scene holds its own clip', async () => {
    const card = await runScreenplay(
      deps(rankerModel({ score: (s, d) => (d.includes(s.dialogue[0]![1]) ? 9 : 1) })),
    );
    expect(card, JSON.stringify(card)).toMatchObject({
      input: 'screenplay',
      pass: true,
      status: 'completed',
      violations: [],
    });
    expect(card.checkpoints).toMatchObject({ met: 3, missed: [] });
  }, 180_000);

  test('a ranker that gives every scene the same clip fails the scorecard with the scenes named', async () => {
    const card = await runScreenplay(
      deps(rankerModel({ score: (_s, d) => (d.includes('dawn') ? 9 : 0) })),
    );
    expect(card.pass).toBe(false);
    expect(card.violations.length).toBeGreaterThan(0);
    expect(card.violations[0]).toMatch(/^scene \d \(.*\): (a placeholder|the wrong clip)$/);
  }, 180_000);

  test('seeded transcript: words spread over the clip, one speech region', () => {
    const t = seededTranscript('one two three', 3000);
    expect(t.words.map((w) => w.text)).toEqual(['one', 'two', 'three']);
    expect(t.words.every((w) => w.endMs <= 3000 && w.startMs >= 0)).toBe(true);
    expect(t.speechRegions).toHaveLength(1);
  });
});
