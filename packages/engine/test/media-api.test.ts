// Face model fetch (pinned URL + SHA-256, over the checked public connection; no internet here:
// a local server behind a fake resolver/dial) and zod ↔ JSON Schema agreement for the transcribe
// and doctext tools (plan phase 04 step 3).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FACE_MODEL, FacetrackToolRequestSchema, ensureFaceModel } from '../src/media-api.ts';
import { DocTextResultSchema } from '../src/stages/ingest.ts';
import {
  TranscribeToolRequestSchema,
  TranscribeToolResultSchema,
} from '../src/stages/transcribe.ts';
import { tempDir } from './helpers/store.ts';

const repo = new URL('../../../', import.meta.url).pathname;
const realModel = [
  process.env['VOX_TEST_MODELS_DIR'],
  `${repo}py/cache/models`,
  `${repo}../../py/cache/models`,
]
  .filter((d): d is string => !!d)
  .map((d) => join(d, FACE_MODEL.name))
  .find((p) => existsSync(p));

let server: Server;
let body: Buffer = Buffer.from('not the model');
let hits = 0;
let port = 0;
beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const net = () => ({
  resolver: async () => ['93.184.216.34'],
  dial: () => ({ host: '127.0.0.1', port }),
});
const url = () => `http://models.example.com:${port}/blaze_face_full_range.tflite`;

describe('ensureFaceModel', () => {
  test('a download with the wrong SHA-256 fails after the retries and leaves nothing', async () => {
    body = Buffer.from('not the model');
    hits = 0;
    const dir = tempDir();
    const e = await ensureFaceModel(dir, {
      net: net(),
      url: url(),
      sleep: async () => undefined,
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'TOOL_FAILED' });
    expect(hits).toBe(4);
    expect(readdirSync(dir)).toEqual([]);
  });

  test.skipIf(!realModel)(
    'the pinned bytes are saved once; a second call does not download',
    async () => {
      body = readFileSync(realModel!);
      hits = 0;
      const dir = tempDir();
      const path = await ensureFaceModel(dir, { net: net(), url: url() });
      expect(path).toBe(join(dir, FACE_MODEL.name));
      await ensureFaceModel(dir, { net: net(), url: url() });
      expect(hits).toBe(1);
    },
  );

  test('a private address is refused (NET_BLOCKED), never retried', async () => {
    hits = 0;
    const e = await ensureFaceModel(tempDir(), {
      net: { resolver: async () => ['127.0.0.1'] },
      url: url(),
      sleep: async () => undefined,
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'NET_BLOCKED' });
    expect(hits).toBe(0);
  });
});

const ajv = new Ajv2020({ strict: true, allErrors: true });
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
const schema = (name: string) => {
  let v = compiled.get(name);
  if (!v) {
    v = ajv.compile(
      JSON.parse(readFileSync(`${repo}py/tests/schemas/${name}.json`, 'utf8')) as object,
    );
    compiled.set(name, v);
  }
  return v;
};

describe('zod agrees with the Python JSON Schemas', () => {
  const cases: [string, { safeParse(v: unknown): { success: boolean } }, unknown][] = [
    [
      'transcribe.request',
      TranscribeToolRequestSchema,
      { audioPath: '/a.m4a', fillers: ['um'], language: null },
    ],
    ['transcribe.request', TranscribeToolRequestSchema, { audioPath: '' }],
    ['transcribe.request', TranscribeToolRequestSchema, { audioPath: '/a', extra: 1 }],
    [
      'transcribe.result',
      TranscribeToolResultSchema,
      {
        language: 'en',
        words: [{ text: 'hi', startMs: 0, endMs: 10 }],
        speechRegions: [{ startMs: 0, endMs: 10 }],
        dropped: { segments: 0, words: 0 },
        model: { repo: 'r', revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb' },
      },
    ],
    [
      'transcribe.result',
      TranscribeToolResultSchema,
      {
        language: 'en',
        words: [{ text: 'hi', startMs: -1, endMs: 10 }],
        speechRegions: [],
        dropped: { segments: 0, words: 0 },
        model: { repo: 'r', revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb' },
      },
    ],
    ['doctext.result', DocTextResultSchema, { text: 'x', pages: 1 }],
    ['doctext.result', DocTextResultSchema, { text: 'x' }],
    [
      'facetrack.request',
      FacetrackToolRequestSchema,
      { videoPath: '/v.mp4', faceModelPath: '/m.tflite' },
    ],
    ['facetrack.request', FacetrackToolRequestSchema, { videoPath: '/v.mp4' }],
  ];
  test.each(cases)('%s case %#', (name, zod, value) => {
    expect(zod.safeParse(value).success).toBe(schema(name)(value));
  });
});
