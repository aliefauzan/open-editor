// Real login Keychain (local tier, D-16: skipped when CI is set; macOS only). Uses service
// `Vox Studio Test` and a unique account, and deletes its item.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createSecurityKeychain } from '../../src/config/keychain.ts';
import { CANARY_KEY } from '../helpers/canary.ts';

const suite = process.platform === 'darwin' && !process.env['CI'] ? describe : describe.skip;

suite('real Keychain via `security -i`', () => {
  const kc = createSecurityKeychain({ service: 'Vox Studio Test' });
  const id = `vox-g1-${randomUUID()}`;
  afterAll(async () => {
    await kc.remove(id);
  });

  it('round-trips the canary key, updates it, and deletes it', async () => {
    expect(await kc.get(id)).toBeNull();
    await kc.set(id, CANARY_KEY);
    expect(await kc.get(id)).toBe(CANARY_KEY);
    await kc.set(id, `${CANARY_KEY}-2`);
    expect(await kc.get(id)).toBe(`${CANARY_KEY}-2`);
    await kc.remove(id);
    expect(await kc.get(id)).toBeNull();
    await kc.remove(id); // missing item is fine
  });

  it('round-trips a key with quotes, backslashes, spaces and unicode', async () => {
    const tricky = "a b\"c\\d;e#f 'g' $(h)";
    await kc.set(id, tricky);
    expect(await kc.get(id)).toBe(tricky);
  });
});
