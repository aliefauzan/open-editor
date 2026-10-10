// No-replace placement of a finished temp file (R4 S2, S32): a file that already sits at the final
// name, or appears there meanwhile, is never replaced. Used by ingest copies and export targets.

import { constants } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';

/** Flags for creating a new file: exclusive, never through a symlink. */
export const EXCL_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** link() errors that mean "this volume has no hard links" (exFAT, some network shares). */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

/**
 * Move `temp` to `final` without ever replacing a file at `final`: true when placed, false when
 * the name is taken. `link` fails with EEXIST atomically. Without hard links, an O_EXCL
 * placeholder claims the name first and the rename then replaces only that empty file of ours.
 * Other errors are thrown; `temp` is left for the caller to remove.
 */
export async function placeNoReplace(temp: string, final: string): Promise<boolean> {
  try {
    await link(temp, final);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') return false;
    if (!NO_LINK.has(code)) throw e;
    try {
      await (await open(final, EXCL_FLAGS, 0o644)).close();
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
    await rename(temp, final);
    return true;
  }
  // Placed. A temp that cannot be removed now is swept later; the placement itself succeeded.
  await unlink(temp).catch(() => undefined);
  return true;
}
