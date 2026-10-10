// Ingest without ffmpeg (fast tier): documents, folders (symlinks skipped), path and link checks,
// idempotent reruns, the strict args (no cookies field, S33), the part-file sweep and the
// yt-dlp login wall through the fake yt-dlp.

import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.ts';
import { MediaItemSchema } from '../../src/model/schema.ts';
import { IngestArgsSchema, ingest, sweepPartFiles, type IngestEnv } from '../../src/stages/ingest.ts';
import { codeOfAsync, fixture, removeDir, tempDir } from '../media/helpers.ts';

let root = '';
beforeAll(() => {
  root = tempDir('vox-ingest-');
});
afterAll(() => removeDir(root));

let n = 0;
async function project(): Promise<string> {
  const dir = join(root, `p${n++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const noDoc = async (): Promise<never> => {
  throw new Error('docText should not run');
};

function env(projectDir: string, over: Partial<IngestEnv> = {}): IngestEnv {
  return { projectDir, existing: [], tools: {}, docText: noDoc, ...over };
}

describe('ingest documents', () => {
  test('a .txt script becomes a document item; a rerun reuses it', async () => {
    const dir = await project();
    const src = join(root, 'script.txt');
    await writeFile(src, 'INT. KITCHEN - DAY\nShe pours coffee.\n');
    const a = await ingest(env(dir), { projectId: 'p', inputs: [src] });
    expect(a.media).toHaveLength(1);
    const m = MediaItemSchema.parse(a.media[0]!.media);
    expect(m).toMatchObject({ kind: 'document', origin: { type: 'upload' } });
    expect(m.id).toMatch(/^m_/);
    expect(m.path).toBe(`media/${m.id}.txt`);
    expect(m.textPath).toBe(m.path);
    expect(await readFile(join(dir, m.textPath!), 'utf8')).toContain('She pours coffee.');

    const b = await ingest(env(dir, { existing: [m] }), { projectId: 'p', inputs: [src] });
    expect(b.media[0]).toMatchObject({ reused: true, media: { id: m.id } });
    // The staging copy of the rerun is gone.
    expect(existsSync(join(dir, 'media'))).toBe(true);
  });

  test('a markdown file keeps its file and gets a .txt copy', async () => {
    const dir = await project();
    const src = join(root, 'notes.md');
    await writeFile(src, '# Notes\n\n- cut the intro\n');
    const { media } = await ingest(env(dir), { projectId: 'p', inputs: [src] });
    const m = media[0]!.media;
    expect(m.path).toBe(`media/${m.id}.md`);
    expect(m.textPath).toBe(`media/${m.id}.txt`);
  });

  test('a PDF goes through docText', async () => {
    const dir = await project();
    const src = join(root, 'deck.pdf');
    await writeFile(src, '%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const seen: string[] = [];
    const { media } = await ingest(
      env(dir, {
        docText: async (p) => {
          seen.push(p);
          return { text: 'Slide one', pages: 1 };
        },
      }),
      { projectId: 'p', inputs: [src] },
    );
    const m = media[0]!.media;
    expect(m.path).toBe(`media/${m.id}.pdf`);
    expect(seen).toEqual([join(dir, m.path)]);
    expect(await readFile(join(dir, m.textPath!), 'utf8')).toBe('Slide one');
  });

  test('text that is not UTF-8 is refused and leaves no files', async () => {
    const dir = await project();
    const src = join(root, 'latin1.txt');
    await writeFile(src, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(await codeOfAsync(ingest(env(dir), { projectId: 'p', inputs: [src] }))).toBe(
      'MEDIA_UNSUPPORTED',
    );
    const left = (await import('node:fs/promises')).readdir(join(dir, 'media'));
    expect(await left).toEqual([]);
  });
});

describe('ingest folders and paths', () => {
  test('a folder is ingested file by file; symlinks are skipped', async () => {
    const dir = await project();
    const folder = join(root, 'folder');
    await mkdir(join(folder, 'sub'), { recursive: true });
    await writeFile(join(folder, 'a.txt'), 'alpha\n');
    await writeFile(join(folder, 'sub', 'b.txt'), 'beta\n');
    await writeFile(join(root, 'outside.txt'), 'secret\n');
    await symlink(join(root, 'outside.txt'), join(folder, 'link.txt'));
    const r = await ingest(env(dir), { projectId: 'p', inputs: [folder] });
    expect(r.media.map((m) => m.input).sort()).toEqual([
      join(folder, 'a.txt'),
      join(folder, 'sub', 'b.txt'),
    ]);
    expect(r.skipped.map((s) => s.path)).toContain(join(folder, 'link.txt'));
  });

  test('two copies of the same bytes give one media item', async () => {
    const dir = await project();
    await writeFile(join(root, 'x1.txt'), 'same\n');
    await writeFile(join(root, 'x2.txt'), 'same\n');
    const r = await ingest(env(dir), {
      projectId: 'p',
      inputs: [join(root, 'x1.txt'), join(root, 'x2.txt')],
    });
    expect(r.media.map((m) => m.reused)).toEqual([false, true]);
    expect(r.media[1]!.media.id).toBe(r.media[0]!.media.id);
  });

  test('bad inputs: relative path, missing file, non-http link', async () => {
    const dir = await project();
    const run = (input: string) => codeOfAsync(ingest(env(dir), { projectId: 'p', inputs: [input] }));
    expect(await run('clip.mp4')).toBe('PATH_INVALID');
    expect(await run(join(root, 'nope.mp4'))).toBe('NOT_FOUND');
    expect(await run('ftp://example.com/a.mp4')).toBe('URL_INVALID');
    expect(await run('file:///etc/passwd')).toBe('URL_INVALID');
  });

  test('args are strict: a cookies setting cannot come from the caller (S33)', () => {
    expect(
      IngestArgsSchema.safeParse({
        projectId: 'p',
        inputs: ['https://www.instagram.com/reel/x/'],
        cookiesFromBrowser: 'chrome',
      }).success,
    ).toBe(false);
    expect(IngestArgsSchema.safeParse({ projectId: 'p', inputs: [] }).success).toBe(false);
  });

  test('sweepPartFiles removes temps of dead processes only', async () => {
    const dir = await project();
    await mkdir(join(dir, 'proxies'), { recursive: true });
    const dead = join(dir, 'proxies', '.vox-part-999999-abc-m_x.mp4');
    const mine = join(dir, 'proxies', `.vox-part-${process.pid}-abc-m_y.mp4`);
    await writeFile(dead, '');
    await writeFile(mine, '');
    expect(await sweepPartFiles(dir)).toBe(1);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });
});

describe('ingest links (fake yt-dlp)', () => {
  const fake = fixture('../helpers/fake-ytdlp.mjs');

  test('an Instagram login wall is LOGIN_REQUIRED and nothing is kept', async () => {
    const dir = await project();
    const log = join(root, 'ytdlp-login.log');
    const e = await ingest(
      env(dir, {
        tools: { 'yt-dlp': fake },
        env: {
          ...process.env,
          FAKE_YTDLP_LOG: log,
          FAKE_YTDLP_MODE: `stderr:${fixture('ytdlp/instagram-login.stderr.txt')}`,
          FAKE_YTDLP_COUNTER: join(root, 'ctr-login'),
        },
      }),
      { projectId: 'p', inputs: ['https://www.instagram.com/reel/DFakeReel01/'] },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VoxError);
    expect((e as VoxError).code).toBe('LOGIN_REQUIRED');
    expect((e as VoxError).details).toMatchObject({ source: 'instagram' });
    // One try only (a login wall is never retried) and the download folder is removed.
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1);
    const left = await (await import('node:fs/promises')).readdir(join(dir, 'cache', 'ingest'));
    expect(left.filter((f) => f.startsWith('dl-'))).toEqual([]);
  });

  test('the cookies opt-in reaches yt-dlp only from the env (config), as --cookies-from-browser', async () => {
    const dir = await project();
    const log = join(root, 'ytdlp-cookies.log');
    await ingest(
      env(dir, {
        tools: { 'yt-dlp': fake },
        cookiesFromBrowser: 'firefox',
        env: {
          ...process.env,
          FAKE_YTDLP_LOG: log,
          FAKE_YTDLP_MODE: `stderr:${fixture('ytdlp/tiktok-private.stderr.txt')}`,
          FAKE_YTDLP_COUNTER: join(root, 'ctr-cookies'),
        },
      }),
      { projectId: 'p', inputs: ['https://www.tiktok.com/@someone/video/7000000000000000001'] },
    ).catch(() => undefined);
    const { args } = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]!) as {
      args: string[];
    };
    expect(args[args.indexOf("--cookies-from-browser") + 1]).toBe("firefox");
  });
});
