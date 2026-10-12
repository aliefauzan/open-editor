// `vox style extract <link|file> --name <name>` and `vox agent <project> <link|file> --workflow
// style-extract` (styles spec "Part C", agent spec "Style extract"; plan phase 15). Code-driven: it
// needs no editor model; the `vision` role from the config describes the reference when it is set
// (else the draft is made from measurements only). The cost cap is `limits.maxUsdPerRun` or --max-usd.
import {
  budgetHost,
  buildRunModels,
  engineConfigIO,
  loadAgentConfig,
  runStyleExtractWorkflow,
  STYLE_EXTRACT_LIMITS,
  type AgentConfigDeps,
} from '@vox/agent';
import type { Engine } from '@vox/engine';
import type { AgentIo } from './agent.ts';
import { depsOf } from './config.ts';

export class StyleExtractUsageError extends Error {}

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

export async function styleExtractCommand(
  engine: Engine,
  source: string,
  values: Record<string, unknown>,
  io: AgentIo,
): Promise<number> {
  const json = values['json'] === true;
  const name = values['name'];
  if (!source.trim())
    throw new StyleExtractUsageError('style extract needs a link or a video file');
  if (typeof name !== 'string' || !name.trim())
    throw new StyleExtractUsageError('style extract needs --name <name>');
  let maxUsd: number | undefined;
  if (values['max-usd'] !== undefined) {
    maxUsd = Number(values['max-usd']);
    if (!/^\d+(\.\d+)?$/.test(String(values['max-usd'])) || !(maxUsd > 0))
      throw new StyleExtractUsageError('--max-usd must be a positive amount, e.g. 2 or 0.5');
  }
  const redactor = engine.redactor;
  const deps = depsOf(io);
  const cfg: AgentConfigDeps = {
    io: engineConfigIO(io.env),
    keychain: deps.keychain,
    env: io.env,
    redactor,
  };
  const conf = await loadAgentConfig(cfg);
  const built = await buildRunModels(conf, cfg, {
    createModel: deps.createModel,
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
    ...(deps.apple !== undefined && { apple: deps.apple }),
    ...(deps.probe.context !== undefined && { context: deps.probe.context }),
  });
  const vision = built.models.vision;
  if (!vision && !json)
    io.stderr('No vision model is set: the draft is made from measurements only.\n');
  const stop = new AbortController();
  const onInterrupt =
    deps.onInterrupt ??
    ((handler: () => void) => {
      process.once('SIGINT', handler);
      return () => void process.off('SIGINT', handler);
    });
  const removeInterrupt = onInterrupt(() => {
    io.stderr('stopping…\n');
    stop.abort();
  });
  const progress =
    io.isTTY && !json
      ? (v: number, msg: string) =>
          io.stderr(clean(`\rextract: ${String(Math.round(v * 100))} % ${msg.slice(0, 60)}\x1b[K`))
      : undefined;
  const { result, summary } = await runStyleExtractWorkflow(
    deps.wrapEngine ? deps.wrapEngine(engine) : engine,
    budgetHost(vision, maxUsd ?? conf.limits.maxUsdPerRun),
    {
      source: source.trim(),
      name: name.trim(),
      ...(values['no-render'] === true && { render: false }),
      signal: stop.signal,
      ...(progress && { onProgress: progress }),
    },
    deps.styleExtractSteps ?? {},
  ).finally(() => {
    removeInterrupt();
    if (progress) io.stderr('\r\x1b[K');
  });
  io.stdout(
    redactor.redact(
      json
        ? `${JSON.stringify(result, null, 2)}\n`
        : clean(`${summary}\n${STYLE_EXTRACT_LIMITS}\n`),
    ),
  );
  return result.validate.ok ? 0 : 1;
}
