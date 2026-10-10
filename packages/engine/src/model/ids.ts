// Ids (plan R3, D-18): prefix + 8 base-36 time digits + 4 random base-36 digits, so ids sort by creation.
import { randomBytes } from 'node:crypto';

export type IdPrefix = 'p_' | 'm_' | 'seq_' | 'it_' | 'ln_' | 'run_' | 'job_';

export function newId(prefix: IdPrefix): string {
  const time = Date.now().toString(36).padStart(8, '0').slice(-8);
  const rnd = randomBytes(4).readUInt32BE(0).toString(36).padStart(4, '0').slice(-4);
  return `${prefix}${time}${rnd}`;
}
