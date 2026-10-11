import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Text(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256');
  const stream = createReadStream(path, signal === undefined ? {} : { signal });
  for await (const chunk of stream) h.update(chunk as Buffer);
  return h.digest('hex');
}
