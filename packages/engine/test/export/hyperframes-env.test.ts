// The HyperFrames child's environment: no API keys, and the app's Electron runs it as Node.
import { describe, expect, it } from 'vitest';
import { hyperframesEnv } from '../../src/export-api.ts';

describe('hyperframesEnv', () => {
  it('drops keys but keeps ELECTRON_RUN_AS_NODE (the app starts HyperFrames with its own Electron)', () => {
    const env = hyperframesEnv({
      PATH: '/bin',
      HOME: '/h',
      OPENROUTER_API_KEY: 'sk-or-canary',
      ANTHROPIC_API_KEY: 'x',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(env['PATH']).toBe('/bin');
    expect(env['OPENROUTER_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['HYPERFRAMES_NO_TELEMETRY']).toBe('1');
  });
});
