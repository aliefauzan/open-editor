// Engine log (engine spec "Project folder", plan D-16): lines appended to `logs/engine.log`,
// rotated at 5 MB with 3 files kept (engine.log, engine.log.1, engine.log.2). Lines go through the
// redactor once phase 04 provides one.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface EngineLogOptions {
  now?: () => Date;
  redact?: (line: string) => string;
  maxBytes?: number;
}

export class EngineLog {
  private readonly dir: string;
  private readonly file: string;
  private readonly opts: EngineLogOptions;
  private chain: Promise<void> = Promise.resolve();
  private dirMade = false;

  constructor(projectDir: string, opts: EngineLogOptions = {}) {
    this.dir = join(projectDir, 'logs');
    this.file = join(this.dir, 'engine.log');
    this.opts = opts;
  }

  /**
   * Append one line (newlines inside are replaced, so a line is never split). Best effort: a log
   * that cannot be written never fails the caller (the promise always resolves).
   */
  write(message: string): Promise<void> {
    const run = async () => {
      const ts = (this.opts.now ?? (() => new Date()))().toISOString();
      const text = (this.opts.redact ?? ((s: string) => s))(message).replace(/[\r\n]+/g, ' ');
      const line = `${ts} ${text}\n`;
      if (!this.dirMade) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        this.dirMade = true;
      }
      const max = this.opts.maxBytes ?? LOG_MAX_BYTES;
      const size = await stat(this.file).then(
        (s) => s.size,
        () => 0,
      );
      if (size > 0 && size + Buffer.byteLength(line) > max) {
        await rename(`${this.file}.1`, `${this.file}.2`).catch(() => undefined);
        await rename(this.file, `${this.file}.1`);
      }
      await appendFile(this.file, line, { mode: 0o600 });
    };
    this.chain = this.chain.then(() =>
      run().catch(() => {
        this.dirMade = false; // retry the mkdir next time
      }),
    );
    return this.chain;
  }
}
