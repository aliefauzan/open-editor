import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ap, expectCode } from '../helpers/ops.ts';
import { baseProject, richProject } from '../helpers/project.ts';

describe('removeMedia', () => {
  test('fails MEDIA_IN_USE while a clip uses it', () => {
    expectCode(() => ap(richProject(), 'removeMedia', { mediaId: 'm_video' }), 'MEDIA_IN_USE');
  });
  test('removes the library entry only; the file stays on disk (S22)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vox-rm-'));
    mkdirSync(join(dir, 'media'));
    const file = join(dir, 'media', 'm_img.png');
    writeFileSync(file, 'png');
    const p = ap(baseProject(), 'removeMedia', { mediaId: 'm_img' });
    expect(p.media.map((m) => m.id)).not.toContain('m_img');
    expect(existsSync(file)).toBe(true);
  });
});
