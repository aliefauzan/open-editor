import { version } from '@vox/engine';

export function run(argv: readonly string[]): number {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`vox ${version}\n`);
    return 0;
  }
  process.stderr.write('usage: vox --version\n');
  return 2;
}
