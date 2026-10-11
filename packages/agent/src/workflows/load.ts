// Workflow prompt files (agent spec "Workflows"; plan D-15). Each file in `packages/agent/workflows/`
// starts with frontmatter the loop reads: `allowedTools` (the tools sent to the model), `roles` (a
// missing `editor` fails the run at start) and `checkpoints` (enforced in order). The body is the
// workflow prompt. The parser takes only the small YAML subset these files use: `key: value` and
// `key: [a, b, …]` lists that may wrap over several lines.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import { ROLES } from '../providers/roles.ts';

export const WORKFLOW_NAMES = ['clipper', 'stylize', 'edit'] as const;
export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

export const CHECKPOINTS = ['ranges', 'tighten', 'storyboard', 'fill', 'review', 'sound'] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

const unique = <T extends z.ZodType>(item: T, what: string) =>
  z.array(item).refine((a) => new Set(a).size === a.length, { message: `${what} repeats a name` });

const FrontmatterSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  allowedTools: unique(z.string().regex(/^[a-z][a-z0-9_]{0,60}$/), 'allowedTools'),
  roles: unique(z.enum(ROLES), 'roles'),
  checkpoints: unique(z.enum(CHECKPOINTS), 'checkpoints'),
});

export interface Workflow extends z.infer<typeof FrontmatterSchema> {
  prompt: string;
}

const invalid = (message: string) =>
  new VoxError('VALIDATION', `workflow file: ${message}`, 'Fix the workflow frontmatter.');

/** Parses one workflow file (frontmatter + prompt). */
export function parseWorkflow(text: string): Workflow {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) throw invalid('no frontmatter (--- … ---) at the start');
  const fields: Record<string, unknown> = {};
  const lines = m[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) throw invalid(`cannot read line ${JSON.stringify(line)}`);
    let value = kv[2]!.trim();
    if (value.startsWith('[')) {
      while (!value.endsWith(']') && i + 1 < lines.length) value += ` ${lines[++i]!.trim()}`;
      if (!value.endsWith(']')) throw invalid(`${kv[1]!}: the list is not closed`);
      const inner = value.slice(1, -1).trim();
      fields[kv[1]!] = inner === '' ? [] : inner.split(',').map((s) => s.trim());
    } else fields[kv[1]!] = value;
  }
  const r = FrontmatterSchema.safeParse(fields);
  if (!r.success) {
    throw invalid(
      r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  return { ...r.data, prompt: m[2]!.trim() };
}

const cache = new Map<string, Workflow>();

/** Loads `packages/agent/workflows/<name>.md` (or `<dir>/<name>.md`). */
export function loadWorkflow(name: WorkflowName, dir?: string): Workflow {
  if (!(WORKFLOW_NAMES as readonly string[]).includes(name)) {
    throw new VoxError(
      'VALIDATION',
      `unknown workflow ${JSON.stringify(name)}`,
      `Use one of: ${WORKFLOW_NAMES.join(', ')}.`,
    );
  }
  const url =
    dir === undefined ? new URL(`../../workflows/${name}.md`, import.meta.url) : undefined;
  const key = url?.href ?? `${dir!}/${name}.md`;
  let w = cache.get(key);
  if (!w) {
    w = parseWorkflow(readFileSync(url ?? key, 'utf8'));
    if (w.name !== name) throw invalid(`${key} is named ${w.name}, expected ${name}`);
    cache.set(key, w);
  }
  return w;
}
