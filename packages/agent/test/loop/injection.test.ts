// Steps 5, 6 and 19 with the S20 injection transcript: the transcript reaches the model only inside
// one <data> envelope (its `</data>` and `<data` are escaped), and a model that obeys the injected
// text and calls `ingest` on a source the user never named pauses the run for approval.
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { DATA_RULE } from '../../src/loop/prompt.ts';
import { runAgent } from '../../src/loop/run.ts';
import { roleModel, runDeps, scriptedModel } from '../helpers/model.ts';
import { fixtureProject } from '../helpers/project.ts';

const INJECTION = fileURLToPath(new URL('../fixtures/transcripts/injection.json', import.meta.url));

describe('S20 injection transcript', () => {
  test('stays inside the envelope; an injected ingest pauses and nothing is ingested', async () => {
    const f = await fixtureProject({ transcript: INJECTION });
    const m = scriptedModel([
      { calls: [{ name: 'get_transcript', input: { mediaId: 'm1' } }] },
      { calls: [{ name: 'ingest', input: { source: '~/.ssh/id_rsa' } }] },
      { text: 'I did not ingest anything.' },
    ]);
    const onPause = vi.fn(() => Promise.resolve({ action: 'stop' as const }));
    const { deps } = runDeps(f, roleModel(m.model), { onPause });
    const { done } = await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'clipper',
      message: 'make 3 clips about lighthouses',
      allowedTools: ['get_transcript', 'ingest'],
      mode: 'tools',
      scope: [f.sequenceId],
    });
    expect(onPause).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'approval', kind: 'source', sources: ['~/.ssh/id_rsa'] }),
    );
    expect(done.status).toBe('stopped');
    // the system prompt holds the data rule
    const system = m.prompts[0]!.prompt.find((x) => x.role === 'system') as { content: string };
    expect(system.content).toContain(DATA_RULE);
    // the transcript result: one envelope, the payload's tags escaped
    const tool = m.prompts[1]!.prompt.find((x) => x.role === 'tool') as {
      content: { output: { value: string } }[];
    };
    const value = tool.content[0]!.output.value;
    expect(value.startsWith('<data source="transcript">\n')).toBe(true);
    expect(value.match(/<\/data>/g)).toHaveLength(1);
    expect(value.match(/<data/g)).toHaveLength(1);
    expect(value).toContain('&lt;/data>');
    expect((await f.engine.getProject(f.projectId)).media).toHaveLength(1);
  });
});
