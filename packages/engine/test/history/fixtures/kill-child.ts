// Child process for the kill tests: applies renames in a loop, SIGKILLs itself at a write step.
// usage: node kill-child.ts <projectDir> <step|none> <count>
import { ProjectStore, type WriteStep } from '../../../src/history/store.ts';

const [dir, step, count] = process.argv.slice(2) as [string, WriteStep | 'none', string];
const store = await ProjectStore.open(dir, {
  hooks: {
    at: (s) => {
      if (s === step) process.kill(process.pid, 'SIGKILL');
    },
  },
});
process.stdout.write('ready\n');
for (let i = 0; i < Number(count); i++) {
  const name = `k${store.project.version + 1}`;
  await store.apply(
    { op: 'updateSequence', args: { sequenceId: 'seq_1', name } },
    { actor: 'cli' },
  );
  process.stdout.write('w\n');
}
