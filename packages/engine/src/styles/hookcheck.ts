// Hook purity checks for `vox style validate` (styles spec "Compile hook", phase 06 step 3).
// - Static: the hook and every file it imports (relative paths only, inside the style folder, so the
//   hook works in the packaged app without node_modules) must not use a clock, randomness or the
//   network. Node built-ins are allowed except network and process modules.
// - Determinism: each fixture runs through the hook twice with the same seed; the output bytes match.
// Trust (S8) is the security boundary; these checks catch mistakes, they are not a sandbox.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { runHook } from '../compile/hooks.ts';
import type { TemplateDef } from './registry.ts';

export interface HookFinding {
  rule: 'hook-source' | 'hook-import' | 'hook-determinism';
  /** Style-relative file. */
  file: string;
  message: string;
  fixture?: string;
}

const BANNED: [RegExp, string][] = [
  [/\bDate\b/, 'Date (a clock)'],
  [/\bMath\s*\.\s*random\b/, 'Math.random (use ctx.seed)'],
  [/\bperformance\s*\.\s*now\b/, 'performance.now (a clock)'],
  [/\bprocess\s*\.\s*hrtime\b/, 'process.hrtime (a clock)'],
  [/\bfetch\b/, 'fetch (network)'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest (network)'],
  [/\bWebSocket\b/, 'WebSocket (network)'],
  [/\brequire\s*\(/, 'require() (hooks are ES modules; import by relative path)'],
];

/** Built-ins a hook may not import: network and child processes. */
const NETWORK = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'child_process',
  'cluster',
  'worker_threads',
  'inspector',
]);

/** Source without comments (string contents are kept; a lint, not a parser). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

const STATIC_IMPORT =
  /(?:^|[;\s])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/;

export function checkHookSource(styleDir: string, hookPath: string): HookFinding[] {
  const base = realpathSync(styleDir);
  const rel = (p: string) => relative(base, p).split(sep).join('/');
  const findings: HookFinding[] = [];
  const seen = new Set<string>();
  const visit = (file: string) => {
    const real = realpathSync(file);
    if (seen.has(real)) return;
    seen.add(real);
    const name = rel(real);
    const src = stripComments(readFileSync(real, 'utf8'));
    for (const [re, what] of BANNED) {
      if (re.test(src)) findings.push({ rule: 'hook-source', file: name, message: `uses ${what}` });
    }
    if (DYNAMIC_IMPORT.test(src)) {
      findings.push({
        rule: 'hook-import',
        file: name,
        message: 'uses a dynamic import (import a vendored file by a static relative path)',
      });
    }
    for (const m of src.matchAll(STATIC_IMPORT)) {
      const spec = m[2]!;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = resolve(dirname(real), spec);
        if (!existsSync(target)) {
          findings.push({ rule: 'hook-import', file: name, message: `imports missing ${spec}` });
          continue;
        }
        const t = realpathSync(target);
        if (!t.startsWith(base + sep)) {
          findings.push({
            rule: 'hook-import',
            file: name,
            message: `imports ${spec}, outside the style folder`,
          });
          continue;
        }
        visit(t);
      } else if (isBuiltin(spec)) {
        const mod = spec.replace(/^node:/, '').split('/')[0]!;
        if (NETWORK.has(mod)) {
          findings.push({
            rule: 'hook-import',
            file: name,
            message: `imports ${spec} (network or process module)`,
          });
        }
      } else {
        findings.push({
          rule: 'hook-import',
          file: name,
          message: `imports ${spec}: a bare or absolute import; vendor the library as an ESM file in the style folder and import it by relative path`,
        });
      }
    }
  };
  visit(hookPath);
  return findings;
}

/** Output bytes of one hook run: variables (JSON) and files, in name order. */
function bytesOf(r: { vars: Record<string, unknown>; files: [string, string | Uint8Array][] }) {
  const files = r.files.map(([n, c]) => [
    n,
    typeof c === 'string' ? c : Buffer.from(c).toString('base64'),
  ]);
  return JSON.stringify({ vars: r.vars, files });
}

/**
 * Runs the hook twice per fixture with the same instance id (so the same `ctx.seed`); differing output
 * is a `hook-determinism` finding. Throws `HOOK_UNTRUSTED` for an untrusted declaring style.
 */
export async function checkHookDeterminism(
  def: TemplateDef,
  styleDir: string,
  fixtures: { name: string; vars: Record<string, unknown> }[],
): Promise<HookFinding[]> {
  if (!def.hookPath) return [];
  const file = relative(realpathSync(styleDir), realpathSync(def.hookPath)).split(sep).join('/');
  const out: HookFinding[] = [];
  for (const f of fixtures) {
    const id = `validate-${f.name}`;
    const url = (n: string) => `scenes/${id}.files/${n}`;
    const a = bytesOf(await runHook(def, styleDir, f.vars, id, url));
    const b = bytesOf(await runHook(def, styleDir, f.vars, id, url));
    if (a !== b) {
      out.push({
        rule: 'hook-determinism',
        file,
        fixture: f.name,
        message: `two runs with the same seed gave different output for fixture ${f.name}`,
      });
    }
  }
  return out;
}
