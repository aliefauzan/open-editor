// The mock agent model of test builds (`VOX_E2E=1`, unpackaged, `VOX_E2E_AGENT=mock`; plan phase 13
// steps 3 and 3b). Never used in a release build: index.ts only creates it when the app is not
// packaged. It answers from the request alone, like the scripted stylists of the agent tests:
// - tools mode: (first an `ingest` of `VOX_E2E_AGENT_SOURCE` through `call_tool` when the message
//   asks for "b-roll", so the run pauses for the user's approval), then `update_todos` + two
//   `vox/kinetic-serif` beats on the injected view, then the todos done, then a short summary;
// - structured requests: `{ intent: 'edit' }` for the intent gate, else a ClipPlan for the view.
// `VOX_E2E_AGENT_DELAY_MS` delays each answer, so a test can act while the run is going.
import type { createLanguageModel } from '@vox/agent';

type LanguageModelV4 = ReturnType<typeof createLanguageModel>;
type CallOptions = Parameters<LanguageModelV4['doGenerate']>[0];

interface ViewItem {
  startMs: number;
  endMs: number;
  kind: string;
}

interface Step {
  text?: string;
  calls?: { name: string; input: Record<string, unknown> }[];
  json?: unknown;
}

/** The newest injected view in a request: the sequence alias and its items. */
function viewIn(o: CallOptions): { seq: string; items: ViewItem[] } | undefined {
  const text = JSON.stringify(o.prompt);
  const re = /Sequence (s\d+) @v\d+: (\[.*?\])(?:\\n|")/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return undefined;
  try {
    const items = JSON.parse(JSON.parse(`"${last[2]!}"`) as string) as ViewItem[];
    return items.length > 0 ? { seq: last[1]!, items } : undefined;
  } catch {
    return undefined;
  }
}

function userText(o: CallOptions): string {
  const first = o.prompt.find((m) => m.role === 'user');
  return first ? JSON.stringify(first.content) : '';
}

const toolTurns = (o: CallOptions) => o.prompt.filter((m) => m.role === 'tool').length;

function marks(items: readonly ViewItem[]) {
  const end = Math.max(...items.map((i) => i.endMs));
  return {
    end,
    a: Math.round(end * 0.15),
    m: Math.round(end * 0.5),
    b: Math.round(end * 0.85),
  };
}

function toolsStep(o: CallOptions, source: string | undefined): Step {
  const wantsIngest = source !== undefined && /\bb-roll\b/i.test(userText(o));
  const t = toolTurns(o);
  // the edit workflow reaches ingest through call_tool (not in its tool list)
  if (wantsIngest && t === 0)
    return { calls: [{ name: 'call_tool', input: { name: 'ingest', args: { source } } }] };
  const stage = t - (wantsIngest ? 1 : 0);
  const view = viewIn(o);
  if (stage === 0 && view) {
    const { a, m, b } = marks(view.items);
    const scene = (startMs: number, endMs: number, text: string) => ({
      name: 'add_scene',
      input: {
        sequenceId: view.seq,
        trackId: 'V2',
        startMs,
        durationMs: endMs - startMs,
        template: 'vox/kinetic-serif',
        variables: { text },
      },
    });
    return {
      calls: [
        {
          name: 'update_todos',
          input: {
            items: [
              { text: 'Place the title beats', status: 'in_progress' },
              { text: 'Check the result', status: 'pending' },
            ],
          },
        },
        scene(a, m, 'A long video'),
        scene(m, b, 'A short clip'),
      ],
    };
  }
  if (stage === 1) {
    return {
      calls: [
        {
          name: 'update_todos',
          input: {
            items: [
              { text: 'Place the title beats', status: 'done' },
              { text: 'Check the result', status: 'done' },
            ],
          },
        },
      ],
    };
  }
  return { text: 'Placed the scenes.' };
}

function structuredStep(o: CallOptions): Step {
  const schema = JSON.stringify(o.responseFormat ?? {});
  if (schema.includes('"intent"')) return { json: { intent: 'edit' } };
  const view = viewIn(o);
  if (!view) return { json: { sequences: [] } };
  const { end, a, m, b } = marks(view.items);
  return {
    json: {
      sequences: [
        {
          sequenceId: view.seq,
          beats: [
            { startMs: 0, endMs: a, kind: 'speaker' },
            {
              startMs: a,
              endMs: m,
              kind: 'scene',
              template: 'vox/kinetic-serif',
              variables: { text: 'A long video' },
            },
            {
              startMs: m,
              endMs: b,
              kind: 'scene',
              template: 'vox/kinetic-serif',
              variables: { text: 'A short clip' },
            },
            { startMs: b, endMs: end, kind: 'speaker' },
          ],
        },
      ],
    },
  };
}

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

export function e2eAgentModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LanguageModelV4 {
  const delayMs = Math.min(Number(env['VOX_E2E_AGENT_DELAY_MS'] ?? 0) || 0, 30_000);
  const source = env['VOX_E2E_AGENT_SOURCE'] || undefined;
  let n = 0;
  const wait = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve, reject) => {
      if (delayMs <= 0) return resolve();
      const t = setTimeout(resolve, delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason as Error);
      });
    });
  const model = {
    specificationVersion: 'v4',
    provider: 'e2e',
    modelId: 'e2e-mock',
    supportedUrls: {},
    async doGenerate(o: CallOptions) {
      await wait(o.abortSignal);
      const s = structuredStep(o);
      n++;
      return {
        content: [{ type: 'text', text: JSON.stringify(s.json) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream(o: CallOptions) {
      await wait(o.abortSignal);
      const s = toolsStep(o, source);
      const chunks: unknown[] = [];
      if (s.text) {
        chunks.push(
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: s.text },
          { type: 'text-end', id: 't' },
        );
      }
      for (const [k, c] of (s.calls ?? []).entries()) {
        chunks.push({
          type: 'tool-call',
          toolCallId: `call_${String(n)}_${String(k)}`,
          toolName: c.name,
          input: JSON.stringify(c.input),
        });
      }
      n++;
      chunks.push({
        type: 'finish',
        finishReason: { unified: s.calls?.length ? 'tool-calls' : 'stop', raw: 'x' },
        usage: USAGE,
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
          },
        }),
      };
    },
  };
  return model as unknown as LanguageModelV4;
}
