// `vox config providers add|list|remove`, `vox config roles set`, `vox config prices set` and
// `vox config probe` (agent spec "CLI", phase 11). Keys are typed at a hidden prompt (stored in the
// Keychain) or given as `env:NAME` references; a key never comes from the command line (S17). A
// role is set only after its model passes that role's probe (`roles set` exits 1 with the failed
// capability).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
type LanguageModelV4 = ReturnType<typeof createLanguageModel>;
import {
  appleStatus,
  appleStatusInfo,
  assertRoleAssignable,
  createLanguageModel,
  createSecurityKeychain,
  engineConfigIO,
  fetchOpenRouterModels,
  findProvider,
  loadAgentConfig,
  maskedProviders,
  parseKeyRef,
  PresetId,
  presetIds,
  PRESETS,
  probeModel,
  providerKey,
  removeProvider,
  roleCheck,
  ROLES,
  saveProvider,
  setPrice,
  setRole,
  type AgentConfig,
  type AgentConfigDeps,
  type AgentMode,
  type AppleModelOptions,
  type Keychain,
  type OpenRouterModelInfo,
  type PriceEntry,
  type PriceTable,
  type ProbeReport,
  type ProbeRunDeps,
  type ProviderEntry,
  type Role,
  type RoleVerdict,
} from '@vox/agent';
import { createRedactor, VoxError, type Redactor } from '@vox/engine';

/** What `vox config` needs from outside; tests replace any of it. */
export interface AgentCliDeps {
  keychain: Keychain;
  /** The Apple helper; absent when it is not built or installed. */
  apple: AppleModelOptions | undefined;
  fetch: typeof fetch | undefined;
  createModel: (entry: ProviderEntry, modelId: string, apiKey: string | null) => LanguageModelV4;
  /** Extra probe options (tests: `checks`, `context`). */
  probe: Omit<ProbeRunDeps, 'apple'>;
}

export interface ConfigIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  isTTY?: boolean;
  /** Reads one line without echo (API keys). */
  promptSecret?: (question: string) => Promise<string>;
  agent?: Partial<AgentCliDeps>;
  /** The app's Resources folder when the CLI runs bundled in Vox Studio. */
  resources?: string;
}

export class ConfigUsageError extends Error {}

/**
 * The Apple helper: `VOX_APPLE_LLM`; else `<Resources>/bin/vox-apple-llm` in the app; else the dev
 * build in `native/apple-llm`. Absent when none exists.
 */
function appleHelper(io: ConfigIo): AppleModelOptions | undefined {
  const fromEnv = io.env['VOX_APPLE_LLM'];
  if (fromEnv !== undefined && fromEnv !== '') return { command: fromEnv };
  const path =
    io.resources !== undefined
      ? join(io.resources, 'bin', 'vox-apple-llm')
      : fileURLToPath(
          new URL('../../../native/apple-llm/.build/release/vox-apple-llm', import.meta.url),
        );
  return existsSync(path) ? { command: path } : undefined;
}

function depsOf(io: ConfigIo): AgentCliDeps {
  const apple = io.agent && 'apple' in io.agent ? io.agent.apple : appleHelper(io);
  const fetchFn = io.agent?.fetch;
  return {
    keychain: io.agent?.keychain ?? createSecurityKeychain(),
    apple,
    fetch: fetchFn,
    createModel:
      io.agent?.createModel ??
      ((entry, modelId, apiKey) =>
        createLanguageModel(entry, modelId, {
          apiKey,
          ...(fetchFn !== undefined && { fetch: fetchFn }),
          ...(apple !== undefined && { apple }),
        })),
    probe: io.agent?.probe ?? {},
  };
}

/** `<providerId>:<model>`; the model id may itself hold colons (Ollama tags). */
export function parseModelRef(ref: string): { providerId: string; model: string } {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) {
    throw new ConfigUsageError(`expected <provider>:<model>, got ${JSON.stringify(ref)}`);
  }
  return { providerId: ref.slice(0, i), model: ref.slice(i + 1) };
}

/** `--context <model>=<tokens>` (repeatable) → `options.contextTokens`. */
function contextOption(v: unknown): Record<string, number> | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? (v as unknown[]) : [v];
  const out: Record<string, number> = {};
  for (const item of list) {
    const m = typeof item === 'string' ? /^(.+)=(\d+)$/.exec(item) : null;
    if (!m || Number(m[2]) <= 0) {
      throw new ConfigUsageError(
        '--context takes <model>=<tokens>, e.g. --context my-model=128000',
      );
    }
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

function usd(v: unknown, name: string): number {
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) {
    throw new ConfigUsageError(
      `--${name} must be a price in USD per million tokens, e.g. 3 or 0.25`,
    );
  }
  return Number(v);
}

interface Session {
  io: ConfigIo;
  deps: AgentCliDeps;
  cfg: AgentConfigDeps;
  redactor: Redactor;
  json: boolean;
  /** Prints the value (JSON) or the text; both pass through the redactor first (S19). */
  out: (value: unknown, text: string) => void;
}

/** OpenRouter's models list, fetched once per command (context, pricing, modalities). */
async function openRouterModels(
  s: Session,
  entries: readonly ProviderEntry[],
): Promise<Map<string, OpenRouterModelInfo> | undefined> {
  if (s.deps.probe.context?.openRouterModels) return s.deps.probe.context.openRouterModels;
  const or = entries.find((e) => e.type === 'openrouter');
  if (!or) return undefined;
  const base = or.baseUrl ?? (or.preset !== undefined ? PRESETS[or.preset].baseUrl : undefined);
  return fetchOpenRouterModels({
    ...(s.deps.fetch !== undefined && { fetch: s.deps.fetch }),
    ...(base !== undefined && { baseUrl: base }),
  }).catch(() => undefined);
}

function openRouterPrices(models: Map<string, OpenRouterModelInfo> | undefined): PriceTable {
  const table: Record<string, PriceEntry> = {};
  for (const [id, info] of models ?? []) if (info.price !== undefined) table[id] = info.price;
  return table;
}

interface Probed {
  providerId: string;
  model: string;
  report?: ProbeReport;
  error?: { code: string; message: string; hint: string };
  roles: RoleVerdict[];
}

async function probeOne(
  s: Session,
  conf: AgentConfig,
  ref: { providerId: string; model: string },
  models: Map<string, OpenRouterModelInfo> | undefined,
  opts: { mode?: AgentMode; rethrow?: boolean } = {},
): Promise<Probed> {
  const mode = opts.mode;
  const entry = findProvider(conf, ref.providerId);
  try {
    const key = await providerKey(s.cfg, entry);
    const model = s.deps.createModel(entry, ref.model, key);
    const report = await probeModel(entry, ref.model, model, {
      ...s.deps.probe,
      context: {
        ...(s.deps.fetch !== undefined && { fetch: s.deps.fetch }),
        ...(s.deps.apple !== undefined && { apple: s.deps.apple }),
        ...(models !== undefined && { openRouterModels: models }),
        ...s.deps.probe.context,
      },
      ...(s.deps.apple !== undefined && { apple: s.deps.apple }),
    });
    const priceTables = [conf.prices, openRouterPrices(models)];
    const roles = ROLES.map((role) =>
      roleCheck(role, {
        provider: entry,
        model: ref.model,
        probe: report,
        priceTables,
        ...(role === 'editor' && mode !== undefined && { mode }),
      }),
    );
    return { ...ref, report, roles };
  } catch (err) {
    if (!(err instanceof VoxError) || opts.rethrow === true) throw err;
    return { ...ref, error: { code: err.code, message: err.message, hint: err.hint }, roles: [] };
  }
}

const checkText = (name: string, r: { status: string; reason?: string } | undefined) =>
  r === undefined ? '' : `  ${name} ${r.status}${r.reason ? ` (${r.reason})` : ''}\n`;

function probedText(p: Probed): string {
  const head = `${p.providerId}:${p.model}\n`;
  if (p.error) return `${head}  error: ${p.error.message}\n  hint: ${p.error.hint}\n`;
  const r = p.report!;
  let text = head;
  if (r.appleStatus !== undefined) text += `  apple ${r.appleStatus}\n`;
  for (const c of ['tools', 'loop', 'vision', 'plan'] as const) text += checkText(c, r[c]);
  if (r.context) {
    const n = r.context.contextTokens;
    text += `  context ${n === null ? 'unknown' : String(n)} (${r.context.source}${r.context.error ? `, ${r.context.error}` : ''})\n`;
  }
  if (r.toolList) {
    text += `  tool list ${String(r.toolList.tokens)} tokens: ${r.toolList.result.status}${r.toolList.result.status === 'fail' ? ` (${r.toolList.result.reason})` : ''}\n`;
  }
  const ok = p.roles
    .filter((v) => v.assignable)
    .map((v) => (v.mode ? `${v.role} (${v.mode})` : v.role));
  text += `  roles: ${ok.length > 0 ? ok.join(', ') : 'none'}\n`;
  return text;
}

async function providers(s: Session, positionals: string[], values: Record<string, unknown>) {
  const [, sub, arg] = positionals;
  switch (sub) {
    case 'add': {
      if (arg === undefined)
        throw new ConfigUsageError(`providers add needs a preset: ${presetIds.join(', ')}`);
      const preset = PresetId.safeParse(arg);
      if (!preset.success) {
        throw new ConfigUsageError(
          `unknown preset ${JSON.stringify(arg)}; one of ${presetIds.join(', ')}`,
        );
      }
      const id = typeof values['id'] === 'string' ? values['id'] : undefined;
      const baseUrl = typeof values['base-url'] === 'string' ? values['base-url'] : undefined;
      const context = contextOption(values['context']);
      const numCtx = values['num-ctx'];
      if (numCtx !== undefined && (typeof numCtx !== 'string' || !/^[1-9]\d*$/.test(numCtx))) {
        throw new ConfigUsageError('--num-ctx must be a whole number');
      }
      const options = {
        ...(context !== undefined && { contextTokens: context }),
        ...(numCtx !== undefined && { numCtx: Number(numCtx) }),
      };
      if (preset.data === 'apple') {
        if (s.deps.apple === undefined) {
          throw new VoxError(
            'APPLE_UNAVAILABLE',
            'the Apple helper vox-apple-llm is not installed',
            'Build it with `swift build -c release --package-path native/apple-llm`, or set VOX_APPLE_LLM to its path.',
          );
        }
        const status = await appleStatus(s.deps.apple);
        const info = appleStatusInfo(status.status);
        if (!info.usable) {
          throw new VoxError(
            'APPLE_UNAVAILABLE',
            `the Apple on-device model is ${status.status}`,
            info.hint,
            {
              details: { status: status.status },
            },
          );
        }
      }
      let apiKey: string | undefined;
      const keyFlag = values['key'];
      if (PRESETS[preset.data].key === 'required') {
        if (typeof keyFlag === 'string') {
          const ref = parseKeyRef(keyFlag.trim());
          if (ref?.kind !== 'env') {
            throw new ConfigUsageError(
              '--key takes only env:NAME (a key on the command line ends up in shell history); leave it out to type the key',
            );
          }
          apiKey = keyFlag.trim();
        } else {
          if (s.json || !s.io.isTTY || !s.io.promptSecret) {
            throw new ConfigUsageError(
              `providers add ${preset.data} needs --key env:NAME when it cannot ask for the key`,
            );
          }
          const typed = (
            await s.io.promptSecret(`${PRESETS[preset.data].label} API key (hidden): `)
          ).trim();
          if (typed === '') throw new ConfigUsageError('no key was typed');
          s.redactor.addSecrets([typed]);
          apiKey = typed;
        }
      } else if (keyFlag !== undefined) {
        throw new ConfigUsageError(`the ${preset.data} preset takes no API key`);
      }
      const entry = await saveProvider(s.cfg, {
        preset: preset.data,
        ...(id !== undefined && { id }),
        ...(baseUrl !== undefined && { baseUrl }),
        ...(apiKey !== undefined && { apiKey }),
        ...(Object.keys(options).length > 0 && { options }),
      });
      const masked = (await maskedProviders(s.cfg)).find((p) => p.id === entry.id);
      s.out(
        masked,
        `added ${entry.id} (${PRESETS[preset.data].label})${masked?.keyMasked ? `, key ${masked.keyMasked}` : ''}\n`,
      );
      return 0;
    }
    case 'list': {
      const list = await maskedProviders(s.cfg);
      s.out(
        list,
        list.length === 0
          ? 'no providers; add one with `vox config providers add <preset>`\n'
          : list
              .map(
                (p) =>
                  `${p.id}\t${p.preset ?? p.type}\t${p.baseUrl ?? '-'}\t${p.keyMasked ?? `key: ${p.keyRef}`}\n`,
              )
              .join(''),
      );
      return 0;
    }
    case 'remove': {
      if (arg === undefined) throw new ConfigUsageError('providers remove needs a provider id');
      await removeProvider(s.cfg, arg);
      s.out({ removed: arg }, `removed ${arg}\n`);
      return 0;
    }
    default:
      throw new ConfigUsageError('config providers needs add, list or remove');
  }
}

async function roles(s: Session, positionals: string[], values: Record<string, unknown>) {
  const [, sub, roleArg, refArg] = positionals;
  if (sub !== 'set') throw new ConfigUsageError('config roles needs set');
  if (roleArg === undefined || !(ROLES as readonly string[]).includes(roleArg)) {
    throw new ConfigUsageError(`roles set needs a role: ${ROLES.join(', ')}`);
  }
  if (refArg === undefined) throw new ConfigUsageError('roles set needs <provider>:<model>');
  const role = roleArg as Role;
  const ref = parseModelRef(refArg);
  const modeFlag = values['mode'];
  if (modeFlag !== undefined && modeFlag !== 'tools' && modeFlag !== 'plan') {
    throw new ConfigUsageError('--mode must be tools or plan');
  }
  const conf = await loadAgentConfig(s.cfg);
  const entry = findProvider(conf, ref.providerId);
  const models = await openRouterModels(s, [entry]);
  const p = await probeOne(s, conf, ref, models, {
    ...(modeFlag !== undefined && { mode: modeFlag as AgentMode }),
    rethrow: true,
  });
  const verdict = p.roles.find((v) => v.role === role)!;
  if (!verdict.assignable && !s.json) s.io.stderr(s.redactor.redact(probedText(p)));
  // Throws PROBE_FAILED naming the failed capability; the CLI exits 1.
  assertRoleAssignable(role, {
    provider: entry,
    model: ref.model,
    probe: p.report!,
    priceTables: [conf.prices, openRouterPrices(models)],
    ...(role === 'editor' && modeFlag !== undefined && { mode: modeFlag as AgentMode }),
  });
  await setRole(s.cfg, role, ref, verdict);
  s.out(
    { role, ...ref, ...(verdict.mode !== undefined && { mode: verdict.mode }), probe: p.report },
    `${role}: ${ref.providerId}:${ref.model}${verdict.mode ? ` (${verdict.mode} mode)` : ''}\n`,
  );
  return 0;
}

async function prices(s: Session, positionals: string[], values: Record<string, unknown>) {
  const [, sub, model] = positionals;
  if (sub !== 'set' || model === undefined) {
    throw new ConfigUsageError('config prices set <model> --in <usd> --out <usd> | --free');
  }
  let price: PriceEntry;
  if (values['free'] === true) {
    if (values['in'] !== undefined || values['out'] !== undefined) {
      throw new ConfigUsageError('--free takes no --in or --out');
    }
    price = { free: true };
  } else {
    price = { inPerMTok: usd(values['in'], 'in'), outPerMTok: usd(values['out'], 'out') };
  }
  await setPrice(s.cfg, model, price);
  s.out(
    { model, price },
    `${model}: ${'free' in price ? 'free' : `$${String(price.inPerMTok)} in, $${String(price.outPerMTok)} out per million tokens`}\n`,
  );
  return 0;
}

async function probe(s: Session, positionals: string[]) {
  const conf = await loadAgentConfig(s.cfg);
  const refs = positionals.slice(1).map(parseModelRef);
  if (refs.length === 0) {
    for (const r of Object.values(conf.roles)) {
      if (r && !refs.some((x) => x.providerId === r.providerId && x.model === r.model))
        refs.push(r);
    }
  }
  if (refs.length === 0) {
    throw new ConfigUsageError(
      'nothing to probe: name models as <provider>:<model>, or assign roles first',
    );
  }
  for (const r of refs) findProvider(conf, r.providerId);
  const models = await openRouterModels(
    s,
    refs.map((r) => findProvider(conf, r.providerId)),
  );
  const results: Probed[] = [];
  for (const r of refs) results.push(await probeOne(s, conf, r, models));
  s.out(results, results.map(probedText).join(''));
  return results.some((r) => r.error) ? 1 : 0;
}

/** `vox config …`; exit 0 ok, 1 refused or failed (a VoxError), 2 usage (ConfigUsageError). */
export async function configCommand(
  positionals: string[],
  values: Record<string, unknown>,
  io: ConfigIo,
): Promise<number> {
  const redactor = createRedactor();
  const deps = depsOf(io);
  const json = values['json'] === true;
  const s: Session = {
    io,
    deps,
    redactor,
    json,
    cfg: { io: engineConfigIO(io.env), keychain: deps.keychain, env: io.env, redactor },
    out: (value, text) =>
      io.stdout(redactor.redact(json ? `${JSON.stringify(value ?? null, null, 2)}\n` : text)),
  };
  try {
    switch (positionals[0]) {
      case 'providers':
        return await providers(s, positionals, values);
      case 'roles':
        return await roles(s, positionals, values);
      case 'prices':
        return await prices(s, positionals, values);
      case 'probe':
        return await probe(s, positionals);
      default:
        throw new ConfigUsageError('config needs providers, roles, prices or probe');
    }
  } catch (err) {
    // A provider's answer can quote what it was sent: errors leave redacted (S19).
    if (err instanceof VoxError) {
      throw new VoxError(err.code, redactor.redact(err.message), redactor.redact(err.hint), {
        ...(err.details !== undefined && { details: redactor.redact(err.details) }),
      });
    }
    throw err;
  }
}
