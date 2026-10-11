// Shared test fakes: an in-memory Keychain and a temp VOX_HOME config through the engine module.
import { createRedactor, readConfig, writeConfig, type Redactor } from '@vox/engine';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Keychain } from '../../src/config/keychain.ts';
import type { AgentConfigDeps, ConfigIO } from '../../src/config/store.ts';

export function memoryKeychain(): Keychain & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: (id) => Promise.resolve(items.get(id) ?? null),
    set: (id, key) => {
      items.set(id, key);
      return Promise.resolve();
    },
    remove: (id) => {
      items.delete(id);
      return Promise.resolve();
    },
  };
}

export function tempVoxHome(): { env: Record<string, string>; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'vox-agent-home-'));
  return { home, env: { VOX_HOME: home, HOME: home } };
}

export function tempConfigIO(env: Record<string, string>): ConfigIO {
  return { read: () => readConfig(env), write: (patch) => writeConfig(patch, env) };
}

export function configDeps(
  over: Partial<AgentConfigDeps> = {},
): AgentConfigDeps & { keychain: ReturnType<typeof memoryKeychain>; redactor: Redactor; home: string } {
  const { env, home } = tempVoxHome();
  return {
    io: tempConfigIO(env),
    keychain: memoryKeychain(),
    env: {},
    redactor: createRedactor(),
    home,
    ...(over as object),
  } as AgentConfigDeps & { keychain: ReturnType<typeof memoryKeychain>; redactor: Redactor; home: string };
}
