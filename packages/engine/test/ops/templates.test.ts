// switchVariables reads only own keys of the variables and of the target schema (no prototype keys).
import { describe, expect, test } from 'vitest';
import { switchVariables, type TemplateInfo } from '../../src/ops/templates.ts';

const tpl = (
  id: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): TemplateInfo => ({
  id,
  version: '1.0.0',
  kind: 'scene',
  durationMs: { min: 500, default: 2000, max: 10000 },
  variables: { type: 'object', properties, required },
  slots: {},
});

describe('switchVariables', () => {
  test('a variable named like an Object.prototype key is dropped when the target does not declare it', () => {
    const from = tpl('a/x', { title: { type: 'string' } });
    const to = tpl('a/y', { title: { type: 'string' } });
    const r = switchVariables(from, to, { title: 'Hi', constructor: 'x', toString: 'y' });
    expect(r).toEqual({ variables: { title: 'Hi' }, dropped: ['constructor', 'toString'] });
  });

  test('a required target variable named like a prototype key must really be present', () => {
    const from = tpl('a/x', {});
    const to = tpl('a/y', { constructor: { type: 'string' } }, ['constructor']);
    expect(() => switchVariables(from, to, {})).toThrow(/TEMPLATE_INCOMPATIBLE|missing/);
  });
});
