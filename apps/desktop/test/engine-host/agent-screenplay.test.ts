// 14b: the screenplay workflow in the engine host. A screenplay document attached in the chat starts the
// `screenplay` workflow (by the message, or by the quick action's explicit workflow) with the attached
// footage; the run lays the clips out in screenplay order and "Undo this run" removes the sequence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configDeps } from '../../../../packages/agent/test/helpers/fakes.ts';
import {
  rankerModel,
  screenplayKit,
  visionModel,
  tagEntries,
} from '../../../../packages/agent/test/helpers/screenplay.ts';
import { role } from '../../../../packages/agent/test/helpers/workflow.ts';
import { AgentHost } from '../../src/engine-host/agent.ts';

describe('agent host: screenplay (14b)', () => {
  it('the message names a screenplay and a document is attached: the workflow runs, undo removes the sequence', async () => {
    const kit = await screenplayKit();
    await kit.load();
    const ranker = rankerModel();
    const vision = visionModel(tagEntries(kit.dir));
    const events: { type?: string; payload?: Record<string, unknown> }[] = [];
    const h = new AgentHost({
      engine: kit.engine,
      cfg: configDeps(),
      emit: (_n, payload) => void events.push(payload as never),
      models: () =>
        Promise.resolve({
          models: { editor: role(ranker.model), vision: role(vision.model, { vision: true }) },
        }),
      newRunId: () => 'run_hostscreen01',
      runJob: kit.deps.runJob!,
    });
    const before = await kit.engine.getProject(kit.projectId);
    const r = await h.run({
      projectId: kit.projectId,
      message: 'match each scene of the screenplay to the right clip',
      selection: [],
      attachments: [kit.documentId],
    });
    expect(r.workflow).toBe('screenplay');
    await h.idle();
    expect(events.filter((e) => e.type === 'agent.done').at(-1)?.payload).toMatchObject({
      status: 'completed',
    });
    const p = await kit.engine.getProject(kit.projectId);
    const seq = p.sequences.find((s) => !before.sequences.some((b) => b.id === s.id))!;
    const expected = JSON.parse(readFileSync(join(kit.dir, 'expected.json'), 'utf8')) as {
      file: string;
    }[];
    expect(seq.videoTracks[0]!.items.map((i) => (i.type === 'media' ? i.mediaId : i.type))).toEqual(
      expected.map((e) => kit.ids.get(e.file)),
    );
    const [run] = await h.runs(kit.projectId);
    expect(run).toMatchObject({ workflow: 'screenplay', status: 'completed' });
    await h.undoRun(r.runId);
    const after = await kit.engine.getProject(kit.projectId);
    expect(after.sequences).toEqual(before.sequences);
  }, 180_000);
});
