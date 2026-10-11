// The tool registry and the tool surface (agent spec "Tools", "Tool surface"; plan D-15, S22,
// S32, S35). Every engine op and job has a tool; a run sends only its workflow's `allowedTools`
// plus the always-present tools, and reaches the rest through `describe_tool` / `call_tool`,
// which validate and run a tool under the same rules as a direct call.
import type { JSONSchema7 } from '@ai-sdk/provider';
import { jsonSchema, type ToolSet } from 'ai';
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import type { ToolDefinition } from '../providers/tool-cost.ts';
import { jobTools } from './jobs.ts';
import { opTools } from './ops.ts';
import { readTools } from './read.ts';
import type { AgentEngine, AgentTool, ToolContext, ToolOutput } from './types.ts';

/** Sent in every run (agent spec "Tool surface"); `update_todos` only in tools mode. */
export const ALWAYS_PRESENT = [
  'describe_tool',
  'call_tool',
  'get_sequence',
  'update_todos',
  'undo_my_last_edit',
] as const;

/** The clipper and Stylize core set (agent spec "Tool surface"). */
export const CLIPPER_CORE_TOOLS = [
  'get_transcript',
  'get_template',
  'add_scene',
  'update_scene',
  'move_item',
  'trim_item',
  'set_transition',
  'search_images',
  'fetch_image',
  'cutout',
  'view_frames',
  'check_audio',
] as const;

const ID_KEY = /(^ids?$|Ids?$|^wordKeys?$)/;

export interface ToolRegistry {
  get(name: string): AgentTool | undefined;
  names(): string[];
  /** The JSON Schema the model sees (id fields take short ids such as `c1`). */
  modelSchema(name: string): JSONSchema7;
}

const PASS_ID_CONTEXT = new Set(['items', 'anyOf', 'oneOf', 'allOf', 'prefixItems']);

/** Drops the engine id `pattern` under id fields: the model sends short ids (`c1`) there. */
function relaxIds(node: unknown, idContext = false): void {
  if (Array.isArray(node)) {
    for (const x of node) relaxIds(x, idContext);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (idContext && typeof o['pattern'] === 'string') {
    delete o['pattern'];
    o['description'] = 'short id from a tool result, e.g. c1 (item), s1 (sequence), m1 (media)';
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'properties' && v !== null && typeof v === 'object') {
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) relaxIds(pv, ID_KEY.test(pk));
    } else relaxIds(v, PASS_ID_CONTEXT.has(k) && idContext);
  }
}

export function toModelSchema(schema: z.ZodType): JSONSchema7 {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json['$schema'];
  relaxIds(json);
  return json as JSONSchema7;
}

const TodoSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          text: z.string().trim().min(1).max(200),
          status: z.enum(['pending', 'in_progress', 'done']),
        }),
      )
      .max(30),
  })
  .refine((a) => a.items.filter((i) => i.status === 'in_progress').length <= 1, {
    message: 'at most one item may be in_progress',
  });

function unknownTool(name: string, names: readonly string[]): VoxError {
  return new VoxError('TOOL_UNKNOWN', `${JSON.stringify(name)} is not a tool`, `Use one of: ${names.join(', ')}`, {
    details: { name },
  });
}

/** Validation error the model can act on (zod issues, no values). */
export function validationError(name: string, err: z.ZodError): VoxError {
  const issues = err.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return new VoxError('VALIDATION', `${name}: ${issues.join('; ')}`, `Fix the ${name} arguments and call it again.`, {
    details: { tool: name, issues },
  });
}

export interface InvokeOptions {
  /** Reached through `call_tool` (S35: a question turn allows read tools only). */
  viaCallTool?: boolean;
}

/** Resolves aliases, validates with the tool's zod schema and runs it under the run's rules. */
export async function invokeTool(
  ctx: ToolContext,
  registry: ToolRegistry,
  name: string,
  rawArgs: unknown,
  opts: InvokeOptions = {},
): Promise<ToolOutput> {
  const t = registry.get(name);
  if (!t) throw unknownTool(name, registry.names());
  if (opts.viaCallTool && (name === 'call_tool' || name === 'describe_tool')) {
    throw new VoxError('TOOL_REFUSED', `${name} cannot be reached through call_tool`, `Call ${name} directly.`);
  }
  const questionOk =
    t.kind === 'read' || name === 'describe_tool' || (name === 'call_tool' && !opts.viaCallTool);
  if (ctx.question && !questionOk) {
      throw new VoxError(
        'TOOL_REFUSED',
        `${name} changes the project; this turn is a question, so only read tools run`,
        'Answer the question; the user can ask for the edit in a new message.',
        { details: { tool: name } },
      );
  }
  const args = ctx.aliases.fromModel(rawArgs ?? {});
  const parsed = t.input.safeParse(args);
  if (!parsed.success) throw validationError(name, parsed.error);
  return t.run(ctx, parsed.data);
}

export function buildRegistry(engine: Pick<AgentEngine, 'imageProviders'>): ToolRegistry {
  const tools = new Map<string, AgentTool>();
  const add = (t: AgentTool) => {
    if (tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
    tools.set(t.name, t);
  };
  for (const t of [...readTools(), ...opTools(), ...jobTools(engine)]) add(t);
  const schemas = new Map<string, JSONSchema7>();
  const registry: ToolRegistry = {
    get: (n) => tools.get(n),
    names: () => [...tools.keys()].sort(),
    modelSchema(n) {
      const t = tools.get(n);
      if (!t) throw unknownTool(n, registry.names());
      let s = schemas.get(n);
      if (!s) {
        s = toModelSchema(t.input);
        schemas.set(n, s);
      }
      return s;
    },
  };

  add({
    name: 'describe_tool',
    kind: 'meta',
    description: 'The description and input schema of any tool, including tools not in your list.',
    input: z.strictObject({ name: z.string().min(1) }),
    run: (_ctx, a) => {
      const { name } = a as { name: string };
      const t = tools.get(name);
      if (!t) return Promise.reject(unknownTool(name, registry.names()));
      return Promise.resolve({
        result: { name, kind: t.kind, description: t.description, inputSchema: registry.modelSchema(name) },
      });
    },
  });
  add({
    name: 'call_tool',
    kind: 'meta',
    description:
      'Run any tool by name with its arguments (see describe_tool for its schema). Same validation and rules as a direct call.',
    input: z.strictObject({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }),
    run: (ctx, a) => {
      const { name, args } = a as { name: string; args: Record<string, unknown> };
      return invokeTool(ctx, registry, name, args, { viaCallTool: true });
    },
  });
  add({
    name: 'update_todos',
    kind: 'meta',
    description:
      'Replace your short plan for this run: items with status pending, in_progress or done (at most one in_progress). Changes nothing in the project.',
    input: TodoSchema,
    run: (ctx, a) => {
      const { items } = a as z.infer<typeof TodoSchema>;
      ctx.setTodos(items);
      return Promise.resolve({ result: { ok: true, items: items.length } });
    },
  });
  add({
    name: 'undo_my_last_edit',
    kind: 'write',
    description:
      'Undo the newest edit of this run (never the user’s edits). Fails if those items were changed since.',
    input: z.strictObject({}),
    run: async (ctx) => {
      const r = await ctx.engine.undoRun(ctx.projectId, ctx.runId, {
        actor: 'agent',
        runId: ctx.runId,
        last: true,
      });
      if (r.version > ctx.seenVersion) ctx.seenVersion = r.version;
      return {
        result: ctx.aliases.toModel({ version: r.version, results: r.results }),
        versions: [r.version],
        changes: r.changes,
      };
    },
  });
  return registry;
}

/** The names a run sends: `allowedTools` plus the always-present tools (D-15). */
export function surfaceNames(
  registry: ToolRegistry,
  allowedTools: readonly string[],
  opts: { mode: 'tools' | 'plan'; question?: boolean },
): string[] {
  const out: string[] = [];
  const push = (n: string) => {
    if (!out.includes(n)) out.push(n);
  };
  for (const n of allowedTools) {
    const t = registry.get(n);
    if (!t) throw unknownTool(n, registry.names());
    if (opts.question && t.kind !== 'read') continue;
    push(n);
  }
  for (const n of ALWAYS_PRESENT) {
    if (n === 'update_todos' && (opts.mode !== 'tools' || opts.question)) continue;
    if (opts.question && n === 'undo_my_last_edit') continue;
    push(n);
  }
  return out;
}

export function toolDefinitionsFor(registry: ToolRegistry, names: readonly string[]): ToolDefinition[] {
  return names.map((n) => ({
    name: n,
    description: registry.get(n)!.description,
    inputSchema: registry.modelSchema(n),
  }));
}

/** AI SDK tools without `execute`: the loop runs each call itself (repair, aliases, rules). */
export function aiToolSet(registry: ToolRegistry, names: readonly string[]): ToolSet {
  const set: ToolSet = {};
  for (const d of toolDefinitionsFor(registry, names)) {
    set[d.name] = { description: d.description ?? '', inputSchema: jsonSchema(d.inputSchema) };
  }
  return set;
}
