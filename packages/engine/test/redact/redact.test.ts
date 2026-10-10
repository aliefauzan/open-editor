import { describe, expect, it } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import { createRedactor, REDACTED, redactor } from '../../src/redact.ts';

// R4 canary key: must never survive redaction.
const CANARY = 'sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000';

describe('redactor patterns (S19)', () => {
  const r = createRedactor();

  it('removes the R4 canary key (sk-… pattern) from text', () => {
    const out = r.redact(`request failed for key ${CANARY} at step 3`);
    expect(out).not.toContain('CANARY');
    expect(out).toContain(REDACTED);
    expect(out).toContain('at step 3');
  });

  it('removes Authorization and x-api-key header values', () => {
    const text = [
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'x-api-key: abcdef0123456789',
      'X-Goog-Api-Key: AIzaSyA-1234567890abcdef',
      '{"authorization":"Token zzzzzzzzzzzz","other":"kept"}',
    ].join('\n');
    const out = r.redact(text);
    expect(out).not.toMatch(/dXNlcjpwYXNzd29yZA|abcdef0123456789|AIzaSyA|zzzzzzzzzzzz/);
    expect(out).toContain('"other":"kept"');
    expect(out.split('\n')).toHaveLength(4);
  });

  it('removes Bearer tokens', () => {
    const out = r.redact('curl -H "X: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" done');
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('Bearer ' + REDACTED);
    expect(out).toContain('done');
  });

  it('removes key= and api_key= query values but keeps the rest of the URL', () => {
    const out = r.redact(
      'GET https://api.example.com/v1/x?api_key=abc123secretvalue&q=cats&key=AIzaXYZ987654321#frag',
    );
    expect(out).not.toMatch(/abc123secretvalue|AIzaXYZ987654321/);
    expect(out).toContain('q=cats');
    expect(out).toContain('#frag');
    expect(out).toContain('api_key=' + REDACTED);
  });

  it('leaves ordinary text alone (no false positives on words that contain the patterns)', () => {
    const text = 'task-force-alpha-bravo monkey=banana risk-free sort key order';
    expect(r.redact(text)).toBe(text);
  });
});

describe('addSecrets (S19)', () => {
  it('removes registered literal values, including the URL-encoded form', () => {
    const r = createRedactor();
    const secret = 'my+literal/secret=value01';
    r.addSecrets([secret]);
    const out = r.redact(`a ${secret} b ${encodeURIComponent(secret)} c`);
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c`);
  });

  it('ignores empty and very short values, so a mistake never blanks every string', () => {
    const r = createRedactor();
    r.addSecrets(['', 'a', 'abc']);
    expect(r.redact('a b abc')).toBe('a b abc');
  });

  it('keeps values registered on one redactor out of another', () => {
    const a = createRedactor();
    const b = createRedactor();
    a.addSecrets(['only-in-a-0123456789']);
    expect(b.redact('only-in-a-0123456789')).toBe('only-in-a-0123456789');
  });

  it('the shared engine redactor removes the canary once registered', () => {
    redactor.addSecrets([CANARY]);
    expect(redactor.redact(`x${CANARY}y`)).toBe(`x${REDACTED}y`);
  });
});

describe('redact on structured values', () => {
  const r = createRedactor();
  r.addSecrets(['registered-value-0001']);

  it('walks nested objects and arrays and returns a copy', () => {
    const input = {
      url: `https://x.test/?api_key=${CANARY}`,
      responseHeaders: { Authorization: 'Bearer abcdefghijkl', 'content-type': 'json' },
      list: ['ok', { deep: ['registered-value-0001 here'] }],
      n: 3,
      flag: true,
      nothing: null,
    };
    const out = r.redact(input);
    expect(JSON.stringify(out)).not.toMatch(/CANARY|abcdefghijkl|registered-value-0001/);
    expect(out.responseHeaders['content-type']).toBe('json');
    expect(out.responseHeaders.Authorization).toBe(REDACTED);
    expect(out.n).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
    // input untouched
    expect(input.responseHeaders.Authorization).toBe('Bearer abcdefghijkl');
  });

  it('handles cycles', () => {
    const a: Record<string, unknown> = { s: CANARY };
    a['self'] = a;
    const out = r.redact(a);
    expect(out['s']).toBe(REDACTED);
    expect(out['self']).toBe(out);
  });

  it('redacts VoxError message, cause (string, Error, object) and details, keeping the class', () => {
    const inner = new Error(`inner ${CANARY}`);
    const e = new VoxError('PY_TOOL_FAILED', `failed with ${CANARY}`, 'Try again', {
      cause: `stderr tail\nAuthorization: Bearer abcdefghijkl\nregistered-value-0001`,
      details: { url: `https://h.test/?key=${CANARY}` },
    });
    const out = r.redact(e);
    expect(out).toBeInstanceOf(VoxError);
    expect(out.code).toBe('PY_TOOL_FAILED');
    expect(out.hint).toBe('Try again');
    expect(out.message).not.toContain('CANARY');
    expect(String(out.cause)).not.toMatch(/abcdefghijkl|registered-value-0001/);
    expect(String(out.cause)).toContain('stderr tail');
    expect(JSON.stringify(out.details)).not.toContain('CANARY');
    expect(out.stack ?? '').not.toContain('CANARY');

    const nested = r.redact(new VoxError('X', 'm', 'h', { cause: inner }));
    expect((nested.cause as Error).message).toBe(`inner ${REDACTED}`);
    expect(nested.cause).toBeInstanceOf(Error);
    expect(inner.message).toContain('CANARY');
  });
});

describe('redact: wider coverage (review fixes)', () => {
  const r = createRedactor();

  it('replaces values under sensitive keys whole (apiKey, api_key, cookie, token, password)', () => {
    const out = r.redact({
      apiKey: 'plain-provider-key-1234',
      api_key: 'another-1234567',
      Cookie: 'sessionid=abc; csrftoken=def',
      nested: { token: { v: 'deep' }, password: 'hunter2hunter2' },
      tokens: [1, 2, 3],
      model: 'gpt-x',
    });
    expect(out).toEqual({
      apiKey: REDACTED,
      api_key: REDACTED,
      Cookie: REDACTED,
      nested: { token: REDACTED, password: REDACTED },
      tokens: [1, 2, 3],
      model: 'gpt-x',
    });
  });

  it('redacts Cookie and Set-Cookie header lines and escaped JSON header values', () => {
    const out = r.redact(
      'Cookie: sid=abc123\nSet-Cookie: sid=zzz; Path=/\n{\\"authorization\\":\\"Digest a=1, b=2\\"}',
    );
    expect(out).not.toMatch(/abc123|sid=zzz|a=1, b=2/);
  });

  it('walks Map and Set values', () => {
    const out = r.redact({
      m: new Map<string, string>([
        ['authorization', 'Basic xyz'],
        ['note', `uses ${CANARY}`],
      ]),
      s: new Set([`k ${CANARY}`]),
    });
    expect(out.m.get('authorization')).toBe(REDACTED);
    expect(out.m.get('note')).toBe(`uses ${REDACTED}`);
    expect([...out.s]).toEqual([`k ${REDACTED}`]);
  });

  it('redacts an object cause of a VoxError', () => {
    const e = new VoxError('X', 'm', 'h', { cause: { url: `https://x.test/?key=${CANARY}` } });
    expect(JSON.stringify(r.redact(e).cause)).not.toContain('CANARY');
  });

  it('registers the JSON-escaped form of a secret', () => {
    const r2 = createRedactor();
    r2.addSecrets(['quote"and\\slash-123']);
    expect(r2.redact(JSON.stringify({ v: 'quote"and\\slash-123' }))).toBe(`{"v":"${REDACTED}"}`);
  });

  it('never throws (a throwing getter yields REDACTED instead of the value)', () => {
    const bad = {
      get boom(): string {
        throw new Error(CANARY);
      },
    };
    expect(r.redact(bad)).toBe(REDACTED);
  });
});
