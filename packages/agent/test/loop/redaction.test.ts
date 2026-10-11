// Step 2 (R4 S19): the canary key never appears in run records, events, VoxErrors or a forced
// APICallError's mapped error (all fields carry it). A key with no known pattern is covered too,
// because every key is registered with the redactor when read.
import { createRedactor } from '@vox/engine';
import { APICallError } from 'ai';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { toVoxErrorJson } from '../../src/errors.ts';
import { mapProviderError } from '../../src/loop/provider-errors.ts';
import { runAgent } from '../../src/loop/run.ts';
import { CANARY_KEY } from '../helpers/canary.ts';
import { roleModel, runDeps, scriptedModel } from '../helpers/model.ts';
import { fixtureProject } from '../helpers/project.ts';

const PLAIN_KEY = 'gw-local-CANARY-7f3a9b2c4d5e6f708192';
const SECRETS = [CANARY_KEY, PLAIN_KEY];

function leakyError(status: number) {
  const both = `${CANARY_KEY} ${PLAIN_KEY}`;
  return new APICallError({
    message: `request failed with key ${both}`,
    url: `https://openrouter.ai/api/v1/chat?key=${PLAIN_KEY}&k2=${CANARY_KEY}`,
    requestBodyValues: { apiKey: CANARY_KEY, note: both },
    statusCode: status,
    responseHeaders: { authorization: `Bearer ${CANARY_KEY}`, 'x-echo': PLAIN_KEY },
    responseBody: `{"error":"bad key ${both}"}`,
    data: { key: PLAIN_KEY, nested: { canary: CANARY_KEY } },
    isRetryable: false,
  });
}

const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

describe('redaction (step 2, S19)', () => {
  test.each([401, 400, 429, 503])(
    'a forced APICallError (HTTP %i) maps to a VoxError with no key',
    (status) => {
      const r = createRedactor();
      r.addSecrets(SECRETS);
      const m = mapProviderError(leakyError(status), 'OpenRouter', r);
      expect(leaks(JSON.stringify(toVoxErrorJson(m.error)))).toEqual([]);
      expect(leaks(String(m.error.stack))).toEqual([]);
      expect(leaks(JSON.stringify(m.error.details ?? {}))).toEqual([]);
    },
  );

  test('a run that sees the key in model text, tool args and a provider error leaks it nowhere', async () => {
    const f = await fixtureProject();
    const m = scriptedModel([
      {
        text: `I will use ${CANARY_KEY} and ${PLAIN_KEY}`,
        calls: [{ name: 'search_transcript', input: { query: `find ${PLAIN_KEY}` } }],
      },
      { error: leakyError(401) },
    ]);
    const { deps, events } = runDeps(f, roleModel(m.model));
    deps.redactor.addSecrets(SECRETS);
    const { done, run } = await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'hello',
      allowedTools: ['search_transcript'],
      mode: 'tools',
      scope: [f.sequenceId],
    });
    expect(done).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_AUTH' } });
    const record = readFileSync(run.record.path, 'utf8');
    expect(record).toContain('[REDACTED]');
    expect(leaks(record)).toEqual([]);
    expect(leaks(JSON.stringify(events))).toEqual([]);
    expect(leaks(JSON.stringify(done))).toEqual([]);
  });
});
