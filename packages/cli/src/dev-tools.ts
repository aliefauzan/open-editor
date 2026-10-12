// Dev checkout guards (D-87). A `vox` run from a checkout (not the CLI bundled in the app) must not run
// code older than the checkout without saying so:
// - Python env: with VOX_TOOLS_DIR (a gate or dev tools folder, often copied from an installed app),
//   the engine re-syncs a stale `<tools>/py-env` from the checkout's py/ before the first Python tool,
//   with the app's own sync command and stamps (D-12). The default folder belongs to the installed
//   app and is never changed: a stale env there is left out, so the tools run in py/.venv (`uv run
//   --frozen` syncs it from the checkout by itself).
// - Apple helper: a dev build older than the checkout's Swift sources gets a warning (an mtime check;
//   a rebuild takes minutes and needs Xcode, so nothing rebuilds it here).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableCheckoutPyEnvSync, PY_ENV_STALE_WHAT, pyEnvStamp } from '@vox/engine';

type Tools = Record<string, string | undefined>;

export interface CheckoutIo {
  env: Readonly<Record<string, string | undefined>>;
  stderr: (s: string) => void;
}

/** The tools a checkout's CLI hands the engine (see the file comment). */
export async function checkoutTools(io: CheckoutIo, tools: Tools): Promise<Tools> {
  const dir = tools['dir'];
  if (!dir || !tools['pyEnv']) return tools;
  const explicit = io.env['VOX_TOOLS_DIR'];
  if (explicit !== undefined && explicit !== '') {
    enableCheckoutPyEnvSync(dir, { log: (line) => io.stderr(`${line}\n`) });
    return tools;
  }
  const s = await pyEnvStamp(tools);
  if (s === undefined || s.state === 'current') return tools;
  io.stderr(
    `vox: not using the Python env in ${s.pyEnv}: it belongs to the installed app and was built from ${PY_ENV_STALE_WHAT[s.state]}; the Python tools run in this checkout's py/.venv (uv run --frozen). Set VOX_TOOLS_DIR to a tools folder of your own to sync and use one.\n`,
  );
  const rest = { ...tools };
  delete rest['pyEnv'];
  return rest;
}

/** The checkout's Swift package of the Apple helper. */
export const NATIVE_APPLE_LLM = fileURLToPath(
  new URL('../../../native/apple-llm', import.meta.url),
);

function newestMtime(path: string): number {
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, name)));
  return newest;
}

/**
 * Whether the helper binary is older than the newest Swift source of the checkout (Package.swift,
 * Package.resolved, Sources/). Undefined when the binary or the package is not there.
 */
export function appleHelperFreshness(
  command: string,
  nativeDir = NATIVE_APPLE_LLM,
): { stale: boolean; helperMs: number; sourcesMs: number } | undefined {
  let helperMs: number;
  try {
    helperMs = statSync(command).mtimeMs;
  } catch {
    return undefined;
  }
  const sourcesMs = Math.max(
    newestMtime(join(nativeDir, 'Package.swift')),
    newestMtime(join(nativeDir, 'Package.resolved')),
    newestMtime(join(nativeDir, 'Sources')),
  );
  if (sourcesMs === 0) return undefined;
  return { stale: helperMs < sourcesMs, helperMs, sourcesMs };
}

export const APPLE_HELPER_BUILD = 'swift build -c release --package-path native/apple-llm';
