import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/vox.js', import.meta.url));

export function spawnFileSync(args: string[]): string {
  return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}
