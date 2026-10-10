/**
 * Item 8 (recorded only, D-15): how many "um"/"uh" survive mlx-whisper with and without a filler
 * `initial_prompt` on `speech-fillers.wav`. Runs bench/fillers.py through `uv run --with` (not
 * added to `py/`; phase 04 pins it there).
 *
 *   node bench/fillers.ts [--evidence-dir DIR]
 */
import path from 'node:path';
import { FIXTURES } from '../make-project.ts';
import { runOk } from '../lib/proc.ts';
import { emit, ensureBenchLock, load, writeEvidence } from './lib.ts';

export const MLX_WHISPER = '0.4.3';
export const MLX = '0.32.3';

async function main() {
  ensureBenchLock();
  const wav = path.join(FIXTURES, 'speech-fillers.wav');
  const before = load();
  const r = await runOk(
    'uv',
    [
      'run',
      '--no-project',
      '--python',
      '3.12',
      '--with',
      `mlx-whisper==${MLX_WHISPER}`,
      '--with',
      `mlx==${MLX}`,
      'python',
      '-I',
      path.join(import.meta.dirname, 'fillers.py'),
      wav,
    ],
    { env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1' } },
  );
  const out = JSON.parse(r.stdout.toString().trim().split('\n').pop()!) as {
    withoutPrompt: {
      fillers: number;
      um: number;
      uh: number;
      backToBackRepeats: number;
      text: string;
    };
    withPrompt: {
      fillers: number;
      um: number;
      uh: number;
      backToBackRepeats: number;
      text: string;
    };
  };
  writeEvidence('B-fillers.json', {
    item: 8,
    recordedOnly: true,
    wav: 'fixtures/speech-fillers.wav',
    load: before,
    ...out,
  });
  const pick = (x: typeof out.withPrompt) => ({
    um: x.um,
    uh: x.uh,
    fillers: x.fillers,
    repeats: x.backToBackRepeats,
    text: x.text,
  });
  emit({
    item: 8,
    name: 'fillers',
    pass: null,
    recordedOnly: true,
    spoken: { um: 1, uh: 1, repeats: 1 },
    withoutPrompt: pick(out.withoutPrompt),
    withPrompt: pick(out.withPrompt),
  });
}

if (import.meta.main) await main();
