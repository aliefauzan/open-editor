import { describe, expect, it } from 'vitest';
import {
  SECURITY_BIN,
  createSecurityKeychain,
  resolveApiKey,
  runProcess,
  type RunProcess,
} from '../../src/config/keychain.ts';
import { CANARY_KEY } from '../helpers/canary.ts';

interface Call {
  file: string;
  args: readonly string[];
  input: string | undefined;
}

function spy(result: { code?: number; stdout?: string; stderr?: string } = {}) {
  const calls: Call[] = [];
  const run: RunProcess = (file, args, opts) => {
    calls.push({ file, args: [...args], input: opts?.input });
    return Promise.resolve({
      code: result.code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  };
  return { calls, run };
}

describe('security keychain: set (S30)', () => {
  it('writes through `security -i` with the command on stdin, key never in argv', async () => {
    const s = spy();
    const kc = createSecurityKeychain({ service: 'Vox Studio Test', run: s.run });
    await kc.set('openrouter', CANARY_KEY);
    expect(s.calls).toHaveLength(1);
    const c = s.calls[0] as Call;
    expect(c.file).toBe(SECURITY_BIN);
    expect(c.args).toEqual(['-i']);
    expect(c.input).toBe(
      `add-generic-password -U -s "Vox Studio Test" -a "openrouter" -w "${CANARY_KEY}"\n`,
    );
    expect(JSON.stringify([c.file, ...c.args])).not.toContain(CANARY_KEY);
  });

  it('uses service "Vox Studio" by default', async () => {
    const s = spy();
    await createSecurityKeychain({ run: s.run }).set('x', 'abcdefghijklmnop');
    expect(s.calls[0]?.input).toContain('-s "Vox Studio" ');
  });

  it('escapes quotes and backslashes in the key', async () => {
    const s = spy();
    await createSecurityKeychain({ run: s.run }).set('x', 'a b"c\\d;e#f');
    expect(s.calls[0]?.input).toContain('-w "a b\\"c\\\\d;e#f"\n');
  });

  it.each([
    ['newline (would run a second command)', 'abc\nadd-generic-password -s evil'],
    ['carriage return', 'abc\rdef'],
    ['NUL', 'abc\0def'],
    ['tab', 'abc\tdef'],
    ['DEL', 'abc\x7fdef'],
    ['non-ASCII', 'abc\u00e9\u20ac'],
    ['empty', ''],
  ])('refuses a key with %s, without running anything', async (_n, key) => {
    const s = spy();
    await expect(createSecurityKeychain({ run: s.run }).set('x', key)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(s.calls).toHaveLength(0);
  });

  it.each(['', 'a b', 'a"b', 'a\nb', '-x', 'a/b'])('refuses provider id %j', async (id) => {
    const s = spy();
    await expect(
      createSecurityKeychain({ run: s.run }).set(id, 'abcdefghijklmnop'),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(s.calls).toHaveLength(0);
  });

  it('fails with KEYCHAIN_FAILED and never leaks the key from stderr or the cause', async () => {
    const s = spy({ code: 2, stderr: `usage error near ${CANARY_KEY}\n` });
    const err = await createSecurityKeychain({ run: s.run })
      .set('openrouter', CANARY_KEY)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({ code: 'KEYCHAIN_FAILED' });
    const e = err as Error & { hint: string; cause?: unknown };
    expect(JSON.stringify({ m: e.message, h: e.hint, c: String(e.cause) })).not.toContain(
      CANARY_KEY,
    );
    expect(e.hint).toBeTruthy();
  });
});

describe('security keychain: get and remove', () => {
  it('reads with find-generic-password -w; the key arrives on stdout only', async () => {
    const s = spy({ stdout: `${CANARY_KEY}\n` });
    const key = await createSecurityKeychain({ service: 'Vox Studio Test', run: s.run }).get(
      'openrouter',
    );
    expect(key).toBe(CANARY_KEY);
    expect(s.calls[0]).toEqual({
      file: SECURITY_BIN,
      args: ['find-generic-password', '-s', 'Vox Studio Test', '-a', 'openrouter', '-w'],
      input: undefined,
    });
  });

  it('returns null when the item does not exist (exit 44)', async () => {
    const s = spy({ code: 44, stderr: 'security: SecKeychainSearchCopyNext: not found\n' });
    expect(await createSecurityKeychain({ run: s.run }).get('openrouter')).toBeNull();
  });

  it('fails on other exit codes', async () => {
    const s = spy({ code: 1, stderr: 'boom' });
    await expect(createSecurityKeychain({ run: s.run }).get('openrouter')).rejects.toMatchObject({
      code: 'KEYCHAIN_FAILED',
    });
  });

  it('removes an item and tolerates a missing one', async () => {
    const s = spy({ code: 44 });
    await createSecurityKeychain({ service: 'Vox Studio Test', run: s.run }).remove('openrouter');
    expect(s.calls[0]?.args).toEqual([
      'delete-generic-password',
      '-s',
      'Vox Studio Test',
      '-a',
      'openrouter',
    ]);
    const bad = spy({ code: 1 });
    await expect(createSecurityKeychain({ run: bad.run }).remove('x')).rejects.toMatchObject({
      code: 'KEYCHAIN_FAILED',
    });
  });
});

describe('resolveApiKey', () => {
  const kc = (key: string | null) => ({
    get: () => Promise.resolve(key),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  });

  it('reads env refs from the given environment', async () => {
    const key = await resolveApiKey('env:OPENROUTER_API_KEY', {
      keychain: kc(null),
      env: { OPENROUTER_API_KEY: CANARY_KEY },
    });
    expect(key).toBe(CANARY_KEY);
  });

  it('returns null for an unset or empty env var', async () => {
    expect(await resolveApiKey('env:NOPE', { keychain: kc(null), env: {} })).toBeNull();
    expect(await resolveApiKey('env:E', { keychain: kc(null), env: { E: '' } })).toBeNull();
  });

  it('reads keychain refs through the keychain', async () => {
    expect(await resolveApiKey('keychain:openrouter', { keychain: kc(CANARY_KEY), env: {} })).toBe(
      CANARY_KEY,
    );
    expect(await resolveApiKey('keychain:openrouter', { keychain: kc(null), env: {} })).toBeNull();
  });

  it('rejects an apiKey that is a raw key instead of a reference (S17)', async () => {
    const err = await resolveApiKey(CANARY_KEY, { keychain: kc(null), env: {} }).then(
      () => null,
      (e: unknown) => e as Error & { code: string },
    );
    expect(err?.code).toBe('CONFIG_INVALID');
    expect(err?.message).not.toContain(CANARY_KEY);
  });
});

describe('runProcess', () => {
  it('passes stdin to the child and returns its output', async () => {
    const r = await runProcess('/bin/cat', [], { input: 'hello\n' });
    expect(r).toEqual({ code: 0, stdout: 'hello\n', stderr: '' });
  });

  it('never goes through a shell: metacharacters stay literal', async () => {
    const r = await runProcess('/bin/echo', ['$(whoami); `id` | x'], {});
    expect(r.stdout).toBe('$(whoami); `id` | x\n');
  });

  it('reports a non-zero exit code', async () => {
    const r = await runProcess('/usr/bin/false', [], {});
    expect(r.code).toBe(1);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(runProcess('/nonexistent/vox-binary', [], {})).rejects.toThrow();
  });
});
