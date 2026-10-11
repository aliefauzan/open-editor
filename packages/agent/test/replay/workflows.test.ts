// Phase 12 step 8e (D-15): the mock workflow runs of steps 1, 2, 5 and 8b are committed as replay
// fixtures (`fixtures/*.json`: the request, the setup and the redacted run record, with the repo
// path and temp folders replaced by placeholders). Each replays on a fresh fixture project: the
// recorded model outputs go back through MockLanguageModelV4 and the tool results and history
// versions must match the record. Run with VOX_RECORD_REPLAY=1 to record them again.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readRunRecord, type RecordLine } from '../../src/loop/record.ts';
import { runWorkflow, type WorkflowRequest } from '../../src/workflows/run-workflow.ts';
import { scriptedModel } from '../helpers/model.ts';
import { planStylist, toolsStylist } from '../helpers/stylists.ts';
import {
  dynamicModel,
  FIXTURE_VIDEO,
  quickClipsProject,
  REPO,
  role,
  workflowKit,
  type Kit,
} from '../helpers/workflow.ts';
import { normaliseIds, scriptFromRecord, toolTrace } from './harness.ts';

const DIR = new URL('./fixtures/', import.meta.url).pathname;
const RECORD = process.env['VOX_RECORD_REPLAY'] === '1';

type Setup = 'empty' | 'quick1';
interface Fixture {
  name: string;
  step: string;
  setup: Setup;
  request: Omit<WorkflowRequest, 'projectId' | 'sequenceIds'> & { stylizeQuick?: boolean };
  lines: RecordLine[];
}

const TMP = tmpdir();
/** Repo path and temp folders → placeholders (no personal paths in committed files). */
const toFixture = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v)
      .split(REPO)
      .join('<REPO>')
      .split(TMP)
      .join('<TMP>')
      .replace(/<TMP>\/[A-Za-z0-9._-]+/g, '<TMP>/x'),
  );
const fromFixture = <T>(v: T): T => JSON.parse(JSON.stringify(v).split('<REPO>').join(REPO)) as T;
/** Ids the run cannot fix (sequences, items, media, projects, links, jobs) → order of first sight. */
const comparable = (lines: RecordLine[]) =>
  normaliseIds(
    JSON.parse(
      JSON.stringify(toolTrace(toFixture(lines) as RecordLine[])).replace(
        /\b(seq|it|m|p)_[A-Za-z0-9_-]+/g,
        (id, k: string) => `${k}_X${String(id.length)}`,
      ),
    ),
  ).map((t) => JSON.stringify(t));

async function prepare(setup: Setup): Promise<{ kit: Kit; sequenceIds: string[] }> {
  const kit = await workflowKit();
  const sequenceIds = setup === 'quick1' ? (await quickClipsProject(kit, 1)).sequenceIds : [];
  return { kit, sequenceIds };
}

const RUNS: Omit<Fixture, 'lines'>[] = [
  {
    name: 'clipper-tools',
    step: '1',
    setup: 'empty',
    request: {
      workflow: 'clipper',
      message: `make 3 vox clips from ${FIXTURE_VIDEO}`,
      mode: 'tools',
      count: 3,
      minMs: 4000,
      maxMs: 8000,
      tighten: 'all',
    },
  },
  {
    name: 'clipper-plan',
    step: '2',
    setup: 'empty',
    request: {
      workflow: 'clipper',
      message: `make 3 vox clips from ${FIXTURE_VIDEO}`,
      mode: 'plan',
      count: 3,
      minMs: 4000,
      maxMs: 8000,
      tighten: 'all',
    },
  },
  {
    name: 'stylize-tools',
    step: '5',
    setup: 'quick1',
    request: {
      workflow: 'stylize',
      message: 'add the vox beats',
      mode: 'tools',
      stylizeQuick: true,
    },
  },
  {
    name: 'clipper-subruns',
    step: '8b',
    setup: 'empty',
    request: {
      workflow: 'clipper',
      message: `make 2 vox clips from ${FIXTURE_VIDEO}`,
      mode: 'tools',
      count: 2,
      minMs: 4000,
      maxMs: 8000,
      tighten: 'all',
    },
  },
];

async function play(f: Omit<Fixture, 'lines'>, model: Parameters<typeof role>[0]) {
  const { kit, sequenceIds } = await prepare(f.setup);
  kit.deps.models = { editor: role(model) };
  const { stylizeQuick, ...req } = fromFixture(f.request);
  const r = await runWorkflow(kit.deps, {
    ...req,
    projectId: kit.projectId,
    ...(stylizeQuick && { sequenceIds }),
  });
  return { r, lines: readRunRecord(r.run.record.path) };
}

describe('workflow replay fixtures (step 8e)', () => {
  if (RECORD) {
    test.each(RUNS)(
      'record $name',
      async (f) => {
        const next = f.request.mode === 'plan' ? planStylist() : toolsStylist();
        const { r, lines } = await play(f, dynamicModel(next).model);
        expect(r.done.status, r.done.summary).toBe('completed');
        writeFileSync(
          join(DIR, `${f.name}.json`),
          `${JSON.stringify({ ...toFixture(f), lines: toFixture(lines) }, null, 1)}\n`,
        );
      },
      120_000,
    );
    return;
  }
  const files = readdirSync(DIR).filter((n) => n.endsWith('.json'));
  test('the four recorded runs are committed', () => {
    expect(files.sort()).toEqual(RUNS.map((r) => `${r.name}.json`).sort());
  });
  test.each(files)(
    '%s replays to the same tool results and versions',
    async (file) => {
      const f = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Fixture;
      const m = scriptedModel(scriptFromRecord(f.lines));
      const { r, lines } = await play(f, m.model);
      expect(r.done.status, r.done.summary).toBe('completed');
      expect(comparable(lines)).toEqual(comparable(f.lines));
      expect(m.remaining()).toBe(0);
    },
    120_000,
  );
  test('a changed tool result in a fixture fails the replay', async () => {
    const f = JSON.parse(readFileSync(join(DIR, 'stylize-tools.json'), 'utf8')) as Fixture;
    const i = f.lines.findIndex((l) => l.type === 'tool' && l['tool'] === 'add_scene');
    f.lines[i] = { ...f.lines[i]!, versions: [999] };
    const { lines } = await play(f, scriptedModel(scriptFromRecord(f.lines)).model);
    expect(comparable(lines)).not.toEqual(comparable(f.lines));
  }, 120_000);
});
