// S11 (sender + zod) and S10 (external link allowlist), pure parts.
import { describe, expect, it, vi } from 'vitest';
import { handleCall, isAllowedExternal, isAppSender } from '../../src/main/guard.ts';

const mainFrame = { url: 'vox-app://app/index.html', parent: null };

describe('IPC sender check (S11)', () => {
  it('accepts the main frame of an app window loaded from vox-app://app', () => {
    expect(isAppSender(mainFrame, true)).toBe(true);
  });

  it.each([
    ['a subframe', { url: 'vox-app://app/index.html', parent: mainFrame }, true],
    ['a vox-media frame', { url: 'vox-media://p/p_a/build/seq_a/index.html', parent: null }, true],
    ['another origin', { url: 'https://example.com/', parent: null }, true],
    ['a lookalike host', { url: 'vox-app://app.evil/index.html', parent: null }, true],
    ['a file URL', { url: 'file:///Users/x/index.html', parent: null }, true],
    ['a window that is not an app window', mainFrame, false],
    ['no frame (destroyed)', null, true],
  ])('rejects %s', (_l, frame, appWindow) => {
    expect(isAppSender(frame as never, appWindow as boolean)).toBe(false);
  });
});

describe('handleCall', () => {
  it('forwards a valid call from the app frame with parsed args', async () => {
    const forward = vi.fn(async () => ['x']);
    const r = await handleCall(mainFrame, true, 'projects.list', [], forward);
    expect(r).toEqual({ ok: true, value: ['x'] });
    expect(forward).toHaveBeenCalledWith('projects.list', []);
  });

  it('rejects a subframe call before validation and never forwards it', async () => {
    const forward = vi.fn();
    const r = await handleCall(
      { ...mainFrame, parent: mainFrame },
      true,
      'projects.list',
      [],
      forward,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'IPC_REJECTED' } });
    expect(forward).not.toHaveBeenCalled();
  });

  it('rejects bad args with a zod error and never forwards them', async () => {
    const forward = vi.fn();
    const r = await handleCall(mainFrame, true, 'projects.open', [42], forward);
    expect(r).toMatchObject({ ok: false, error: { code: 'ARGS_INVALID' } });
    expect(forward).not.toHaveBeenCalled();
  });

  it('turns a thrown error into plain error data', async () => {
    const forward = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'PROJECT_NOT_FOUND', hint: 'Check the id' });
    });
    const r = await handleCall(mainFrame, true, 'projects.open', ['p_abc'], forward);
    expect(r).toEqual({
      ok: false,
      error: { code: 'PROJECT_NOT_FOUND', message: 'gone', hint: 'Check the id' },
    });
  });
});

describe('external links (S10)', () => {
  it.each([
    'https://github.com/aliasvox/vox',
    'https://creativecommons.org/licenses/by/4.0/',
    'https://commons.wikimedia.org/wiki/File:X.jpg',
    'https://openrouter.ai/keys',
  ])('opens allowlisted %s', (u) => {
    expect(isAllowedExternal(u)).toBe(true);
  });

  it.each([
    'http://github.com/',
    'https://evil.com/',
    'https://github.com.evil.com/',
    'https://user:pw@github.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'vox-media://p/p_a/x.html',
    'not a url',
  ])('refuses %s', (u) => {
    expect(isAllowedExternal(u)).toBe(false);
  });
});
