// Invalid request lines shared by the zod, fake-helper and real-helper tests, so all three
// reject the same inputs (the fake and the Swift helper validate by hand).
import type { AppleRequestInput } from '../../src/providers/apple-protocol.ts';

const base = {
  id: 'x',
  system: 's',
  messages: [{ role: 'user', content: 'a' }],
  maxTokens: 8,
  temperature: 0,
};

export const invalidRequests: Array<[name: string, request: Record<string, unknown>]> = [
  ['no messages', { ...base, messages: [] }],
  ['last message from the assistant', { ...base, messages: [{ role: 'assistant', content: 'a' }] }],
  ['a system role inside messages', { ...base, messages: [{ role: 'system', content: 'a' }] }],
  ['an extra field in a message', { ...base, messages: [{ role: 'user', content: 'a', x: 1 }] }],
  ['non-string content', { ...base, messages: [{ role: 'user', content: 1 }] }],
  ['maxTokens 0', { ...base, maxTokens: 0 }],
  ['fractional maxTokens', { ...base, maxTokens: 1.5 }],
  ['maxTokens as a string', { ...base, maxTokens: '8' }],
  ['temperature above 2', { ...base, temperature: 2.5 }],
  ['negative temperature', { ...base, temperature: -0.1 }],
  ['missing temperature', { ...base, temperature: undefined }],
  ['missing system', { ...base, system: undefined }],
  ['a schema that is not an object', { ...base, schema: 'string' }],
  ['a schema that is an array', { ...base, schema: [] }],
  ['an unknown field', { ...base, tools: [] }],
  ['negative maxTokens', { ...base, maxTokens: -8 }],
  ['maxTokens 1e300', { ...base, maxTokens: 1e300 }],
  ['maxTokens above 2^53 - 1', { ...base, maxTokens: 2 ** 53 }],
  ['temperature as a string', { ...base, temperature: '0' }],
  ['messages not an array', { ...base, messages: { role: 'user', content: 'a' } }],
  ['a null schema', { ...base, schema: null }],
  [
    'images on an assistant message',
    {
      ...base,
      messages: [
        { role: 'assistant', content: 'a', images: ['/a.png'] },
        { role: 'user', content: 'b' },
      ],
    },
  ],
  ['an empty image list', { ...base, messages: [{ role: 'user', content: 'a', images: [] }] }],
  [
    'a relative image path',
    { ...base, messages: [{ role: 'user', content: 'a', images: ['a.png'] }] },
  ],
  ['a non-string image', { ...base, messages: [{ role: 'user', content: 'a', images: [1] }] }],
  ['images as a string', { ...base, messages: [{ role: 'user', content: 'a', images: '/a.png' }] }],
  [
    '17 images in one message',
    {
      ...base,
      messages: [
        { role: 'user', content: 'a', images: Array.from({ length: 17 }, (_, i) => `/${i}.png`) },
      ],
    },
  ],
  [
    '17 images over two messages',
    {
      ...base,
      messages: [
        { role: 'user', content: 'a', images: Array.from({ length: 9 }, (_, i) => `/${i}.png`) },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c', images: Array.from({ length: 8 }, (_, i) => `/${i}.png`) },
      ],
    },
  ],
];

/**
 * Valid request lines with text that trips naive line splitting or strict UTF-16 handling:
 * U+2028/U+2029 (Node readline splits on them) and a lone surrogate (valid in JSON and JS).
 * Written with plain `JSON.stringify`, so the separators stay raw on the line.
 */
export const awkwardRequest: AppleRequestInput = {
  id: 'awkward',
  system: 'line\u2028separator',
  messages: [{ role: 'user', content: 'para\u2029graph and a lone \ud800 surrogate' }],
  maxTokens: 8,
  temperature: 0,
};
