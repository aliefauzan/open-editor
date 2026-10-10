// Ids (plan R3, D-18): prefix + 8 base-36 time digits + 4 base-36 digits, so ids sort by creation.
// The last 4 digits start at a random value each millisecond and count up within it, so ids made in
// one process never collide (a burst of splits in one op makes many ids in the same millisecond).
import { randomBytes } from 'node:crypto';

export type IdPrefix = 'p_' | 'm_' | 'seq_' | 'it_' | 'ln_' | 'run_' | 'job_';

const SPACE = 36 ** 4;
let lastTime = -1;
let counter = 0;

export function newId(prefix: IdPrefix): string {
  let now = Date.now();
  if (now <= lastTime) {
    now = lastTime;
    counter += 1;
    if (counter >= SPACE) {
      now += 1; // borrow the next millisecond; keeps order and uniqueness
      counter = randomBytes(4).readUInt32BE(0) % (SPACE / 2);
    }
  } else {
    counter = randomBytes(4).readUInt32BE(0) % (SPACE / 2);
  }
  lastTime = now;
  const time = now.toString(36).padStart(8, '0').slice(-8);
  return `${prefix}${time}${counter.toString(36).padStart(4, '0')}`;
}
