// S30 at the lowest level: the real `runProcess` and `createSecurityKeychain` with node's
// child_process.spawn replaced by a spy. The canary key must reach stdin and no argv.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CANARY_KEY } from '../helpers/canary.ts';

interface SpawnCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
  stdin: string;
}
const calls: SpawnCall[] = [];

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: (file: string, args: string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const call: SpawnCall = { file, args: [...args], options, stdin: '' };
    calls.push(call);
    child.stdin.on('data', (d: Buffer) => (call.stdin += d.toString()));
    child.stdin.on('end', () => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  },
}));

describe('keychain spawn spy (S30)', () => {
  it('canary key is on stdin of `security -i`, in no spawned argv', async () => {
    const { createSecurityKeychain } = await import('../../src/config/keychain.ts');
    const kc = createSecurityKeychain({ service: 'Vox Studio Test' });
    await kc.set('openrouter', CANARY_KEY);
    await kc.get('openrouter');
    await kc.remove('openrouter');
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(JSON.stringify([c.file, ...c.args])).not.toContain(CANARY_KEY);
      expect(c.options['shell']).not.toBe(true);
    }
    expect(calls[0]?.args).toEqual(['-i']);
    expect(calls[0]?.stdin).toContain(CANARY_KEY);
  });
});
