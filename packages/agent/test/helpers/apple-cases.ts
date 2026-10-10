// Invalid request lines shared by the zod, fake-helper and real-helper tests, so all three
// reject the same inputs (the fake and the Swift helper validate by hand).
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
];
