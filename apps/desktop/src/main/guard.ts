// IPC sender check + zod validation (S11) and the external-link allowlist (S10). Pure: main/index.ts
// passes the real WebFrameMain; tests pass plain objects.
import {
  appError,
  parseCall,
  type CallResult,
  type ErrorData,
  type Method,
} from '../shared/api.ts';

export const APP_ORIGIN = 'vox-app://app';

/** The parts of an Electron `WebFrameMain` the check reads. */
export interface FrameLike {
  url: string;
  parent: FrameLike | null;
}

/** True only for the main frame of an app window whose page is from `vox-app://app`. */
export function isAppSender(frame: FrameLike | null | undefined, isAppWindow: boolean): boolean {
  if (!frame || !isAppWindow || frame.parent !== null) return false;
  try {
    const u = new URL(frame.url);
    return u.protocol === 'vox-app:' && u.host === 'app';
  } catch {
    return false;
  }
}

function errorData(e: unknown): ErrorData {
  const o = (e ?? {}) as { code?: unknown; message?: unknown; hint?: unknown; details?: unknown };
  return {
    code: typeof o.code === 'string' ? o.code : 'INTERNAL',
    message: typeof o.message === 'string' ? o.message : String(e),
    hint: typeof o.hint === 'string' ? o.hint : 'See the log for details',
    ...(o.details && typeof o.details === 'object'
      ? { details: o.details as Record<string, unknown> }
      : {}),
  };
}

/** Sender check, then zod, then `forward`; every failure comes back as plain data. */
export async function handleCall(
  frame: FrameLike | null | undefined,
  isAppWindow: boolean,
  method: unknown,
  args: unknown,
  forward: (method: Method, args: unknown[]) => Promise<unknown>,
): Promise<CallResult> {
  if (!isAppSender(frame, isAppWindow)) {
    return { ok: false, error: appError('IPC_REJECTED', `Call to ${String(method)} rejected`) };
  }
  const call = parseCall(method, args);
  if (!call.ok) return call;
  try {
    return { ok: true, value: await forward(call.method, call.args) };
  } catch (e) {
    return { ok: false, error: errorData(e) };
  }
}

/** Hosts the app may open in the default browser (licence pages, provider sites). */
export const EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'creativecommons.org',
  'commons.wikimedia.org',
  'www.naturalearthdata.com',
  'opensource.org',
  'openrouter.ai',
  'platform.openai.com',
  'console.anthropic.com',
  'aistudio.google.com',
  'ollama.com',
  'pixabay.com',
  'www.pexels.com',
]);

export function isAllowedExternal(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' && u.username === '' && u.password === '' && EXTERNAL_HOSTS.has(u.host)
  );
}

/**
 * `media.importFiles({ paths })` skips the native dialog; only test builds (`VOX_E2E=1`, unpackaged)
 * accept it (app spec "Engine-host API"). Returns the error for a release build, else null.
 */
export function importPathsError(args: unknown[], testBuild: boolean): ErrorData | null {
  const o = args[1] as { paths?: unknown } | undefined;
  if (o?.paths === undefined || testBuild) return null;
  return appError(
    'ARGS_INVALID',
    'media.importFiles takes no paths; files are chosen in the native dialog',
  );
}
